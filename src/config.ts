export default {
  // Discord bot token
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",

  // Comma-separated vxasr configuration ids, in retry order.
  ASR_CONFIGURATIONS:
    process.env.ASR_CONFIGURATIONS ||
    "qwen-omni/qwen3.5-omni-flash-realtime-2026-03-15",

  // Discord command prefix
  PREFIX: "!",

  // Command for starting transcription
  START_COMMAND: "transcribe",

  // Command for stopping transcription
  STOP_COMMAND: "stop",
  
  // Logging level (1=error, 2=warn, 3=log, 4=info, 5=debug)
  LOG_LEVEL: parseInt(process.env.LOG_LEVEL || "4", 10),
  
  // Voice detection settings
  ACTIVATION_THRESHOLD: 0.5,   // Confidence threshold to start utterance
  DEACTIVATION_THRESHOLD: 0.3, // Lower threshold to maintain active utterance
  SILENCE_DURATION: 1000,      // Allow 1 second of silence before ending speech
};
