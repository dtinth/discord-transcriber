// @ts-check
const Discord = require('discord.js')
const fs = require('fs')
const execFile = require('child_process').execFile
const config = JSON.parse(
  fs.readFileSync(require.resolve('./discord.config.json'), 'utf8')
)
// @ts-ignore
const speech = require('@google-cloud/speech').v1p1beta1
const speechClient = new speech.SpeechClient({
  keyFilename: 'google-cloud.credentials.json'
})

// This is our logger.
const pino = require('pino')({
  prettyPrint: true,
  level: 'trace'
})

// Crash when something unexpected happens.
// Let a process manager (e.g. pm2 or Docker) restart it.
process.on('unhandledRejection', up => {
  throw up
})

// Keep track of billed usage.
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

  /** @type {Discord.VoiceChannel} */
  // @ts-ignore
  const voiceChannel = guild.channels.find(ch => {
    return ch.name === config.voiceChannelName && ch.type === 'voice'
  })
  if (!voiceChannel) {
    throw new Error('Cannot find voice channel.')
  }
  pino.info('Voice channel: %s (%s)', voiceChannel.id, voiceChannel.name)

  /** @type {Discord.TextChannel} */
  // @ts-ignore
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
 * Join the voice channel and start listening.
 * @param {Discord.VoiceChannel} voiceChannel
 * @param {Discord.TextChannel} textChannel
 */
async function join(voiceChannel, textChannel) {
  pino.trace('Joining voice channel...')
  const voiceConnection = await voiceChannel.join()
  const receiver = voiceConnection.createReceiver()
  pino.info('Voice channel joined.')

  // Every 60 seconds, report API usage and money spent.
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

  /**
   * Map of active recognizers.
   * @type {Map<Discord.User, ReturnType<typeof createRecognizer>>}
   */
  const recognizers = new Map()

  /**
   * Returns a recognizer for a specified user, creating a new one if
   * necessary.
   * @param {Discord.User} user
   * @returns {ReturnType<typeof createRecognizer>}
   */
  function getRecognizer(user) {
    if (recognizers.has(user)) {
      // @ts-ignore
      return recognizers.get(user)
    }
    const recognizer = createRecognizer(user)
    recognizers.set(user, recognizer)
    return recognizer
  }

  /**
   * Creates a new Recognizer for the user.
   * The recognizer will self-destruct when user stopped speaking for 500ms.
   * @param {Discord.User} user
   */
  function createRecognizer(user) {
    const hash = require('crypto').createHash('sha256')
    hash.update(`${user}`)
    const obfuscatedId = parseInt(hash.digest('hex').substr(0, 12), 16)

    /**
     * Raw PCM data from discord.js will be written to this file.
     */
    const tmpFile = '.tmp/input' + Date.now() + '.s32'

    /**
     * Write stream for raw PCM data from discord.js.
     */
    const writeStream = fs.createWriteStream(tmpFile)

    /**
     * This promise will be resolved when writeStream is closed.
     */
    const written = new Promise((resolve, reject) => {
      writeStream.on('error', reject)
      writeStream.on('close', resolve)
    })

    /**
     * Timer from handling of a buffer to ending the stream.
     * @type {NodeJS.Timer}
     */
    let timeout
    const start = Date.now()
    const recognizer = {
      /**
       * @param {Buffer} buffer
       */
      handleBuffer(buffer) {
        clearTimeout(timeout)
        writeStream.write(buffer)
        timeout = setTimeout(endStream, Date.now() - start > 10000 ? 500 : 2000)
      }
    }

    let ended = false
    /**
     * Ends the stream and self-destruct the recognizer.
     */
    function endStream() {
      if (ended) return
      ended = true
      recognizers.delete(user)
      pino.trace(
        { activeRecognizers: recognizers.size },
        `Ended stream for ${user}.`
      )
      transcribe()
    }

    /**
     * Transcribe the heard audio into text, and post it.
     */
    async function transcribe() {
      try {
        const audio = await saveAndConvertAudio()
        const audioLength = audio.length / 2 / 16000
        const duration = audioLength.toFixed(2)
        if (audioLength < 1) {
          pino.info(
            `${user} (oid=${obfuscatedId}) spake for ${duration} seconds`
          )
        }
        const billedLength = Math.ceil(audioLength / 15) * 15
        totalBilledThisSession += billedLength
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

    /**
     * Finish writing to tmpFile and convert it to format suitable
     * for Google Cloud Speech-To-Text API.
     */
    async function saveAndConvertAudio() {
      writeStream.end()
      await written
      return new Promise((resolve, reject) => {
        execFile(
          'sox',
          [
            ...['-t', 's32', '-r', '48000', '-c', '1', tmpFile],
            ...['-t', 's16', '-r', '16000', '-c', '1', '-']
          ],
          {
            maxBuffer: 20 * 1048576,
            encoding: 'buffer'
          },
          (error, stdout) => {
            if (error) return reject(error)
            resolve(stdout)
            fs.unlink(tmpFile, err => {
              if (err) {
                pino.error(err, 'Cannot cleanup temp file.')
              }
            })
          }
        )
      })
    }

    pino.trace(
      { activeRecognizers: recognizers.size },
      `Starting voice recognition for ${user} (oid=${obfuscatedId})...`
    )
    return recognizer
  }

  receiver.on('pcm', (user, buffer) => {
    getRecognizer(user).handleBuffer(buffer)
  })
}
