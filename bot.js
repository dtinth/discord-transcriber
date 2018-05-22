const Discord = require('discord.js')
const fs = require('fs')
const sox = require('sox-stream')
const config = require('./discord.config.json')
const speech = require('@google-cloud/speech').v1p1beta1
const speechClient = new speech.SpeechClient({
  keyFilename: 'google-cloud.credentials.json'
})
const pino = require('pino')({
  prettyPrint: true,
  level: 'trace'
})
process.on('unhandledRejection', up => {
  throw up
})
let totalBilledThisSession = 0

const client = new Discord.Client()

pino.info('Logging in...')
client.login(config.token)

client.on('ready', () => {
  pino.info('Discord client ready.')

  const guild = client.guilds.get(config.guildId)
  if (!guild) {
    throw new Error('Cannot find guild.')
  }
  const voiceChannel = guild.channels.find(ch => {
    return ch.name === config.voiceChannelName && ch.type === 'voice'
  })
  if (!voiceChannel) {
    throw new Error('Cannot find voice channel.')
  }
  pino.info('Voice channel: %s (%s)', voiceChannel.id, voiceChannel.name)

  const textChannel = guild.channels.find(ch => {
    return ch.name === config.textChannelName && ch.type === 'text'
  })
  if (!textChannel) {
    throw new Error('Cannot find text channel.')
  }
  pino.info('Text channel: %s (%s)', textChannel.id, textChannel.name)

  join(voiceChannel, textChannel)
})

/**
 * @param {Discord.VoiceChannel} voiceChannel
 * @param {Discord.TextChannel} textChannel
 */
async function join(voiceChannel, textChannel) {
  pino.trace('Joining voice channel...')
  const voiceConnection = await voiceChannel.join()
  const receiver = voiceConnection.createReceiver()
  pino.info('Voice channel joined.')

  let lastReportedUsage = 0
  setInterval(() => {
    if (totalBilledThisSession === lastReportedUsage) {
      return
    }
    lastReportedUsage = totalBilledThisSession
    const money = (lastReportedUsage / 15 * 0.006).toFixed(3)
    textChannel.send(
      `Google Cloud Speech API usage: ${lastReportedUsage} seconds (\$${money})`
    )
  }, 60000)

  const recognizers = new Map()

  /**
   * @param {Discord.User} user
   */
  function getRecognizer(user) {
    if (recognizers.has(user)) {
      return recognizers.get(user)
    }
    const hash = require('crypto').createHash('sha256')
    hash.update(`${user}`)
    const obfuscatedId = parseInt(hash.digest('hex').substr(0, 12), 16)
    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'th',
        maxAlternatives: 1,
        profanityFilter: false,
        metadata: {
          interactionType: 'PHONE_CALL',
          obfuscatedId
        },
        model: 'default'
      },
      singleUtterance: false
    }

    const buffers = []
    let timeout
    const recognizer = {
      listen(audioStream) {
        clearTimeout(timeout)
        pino.trace(`Listening to ${user}...`)
        audioStream
          .pipe(
            sox({
              global: {
                temp: '.tmp'
              },
              input: {
                r: 48000,
                t: 's32',
                c: 1
              },
              output: {
                r: 16000,
                t: 's16',
                c: 1
              }
            })
          )
          .on('error', e => {
            console.error(e)
            endStream()
          })
          .on('data', buffer => {
            buffers.push(buffer)
          })
          .on('end', () => {
            clearTimeout(timeout)
            pino.trace(`Utterance finished for ${user}.`)
            timeout = setTimeout(endStream, 1000)
          })
      }
    }

    let ended = false
    async function endStream() {
      if (ended) return
      ended = true
      recognizers.delete(user)
      pino.trace(
        { activeRecognizers: recognizers.size },
        `Ending stream for ${user}.`
      )
      try {
        const audio = Buffer.concat(buffers)
        const audioLength = audio.length / 2 / 16000
        const billedLength = Math.ceil(audioLength / 15) * 15
        totalBilledThisSession += billedLength
        const duration = audioLength.toFixed(2)
        pino.info(
          { billedLength, totalBilledThisSession },
          `${user} (oid=${obfuscatedId}) spake for ${duration} seconds`
        )
        const [data] = await speechClient.recognize({
          audio: { content: audio.toString('base64') },
          config: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: config.languageCode,
            maxAlternatives: 1,
            profanityFilter: false,
            metadata: {
              interactionType: 'PHONE_CALL',
              obfuscatedId
            },
            model: 'default'
          }
        })
        if (data.results) {
          for (const result of data.results) {
            const alt = result.alternatives && result.alternatives[0]
            if (alt && alt.transcript) {
              textChannel.send(`${user}: ${alt.transcript}`)
              pino.info(`Recognized from ${user}: “${alt.transcript}”`)
            }
          }
        }
      } catch (e) {
        pino.error(e, 'Failed to recognize')
      }
    }

    recognizers.set(user, recognizer)
    pino.trace(
      { activeRecognizers: recognizers.size },
      `Starting voice recognition for ${user} (oid=${obfuscatedId})...`
    )

    return recognizer
  }

  voiceConnection.on('speaking', (user, speaking) => {
    if (speaking) {
      const audioStream = receiver.createPCMStream(user)
      getRecognizer(user).listen(audioStream)
    }
  })
}
