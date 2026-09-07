# Face Recognition Fixture

`face-dialogue-zh.wav` is five seconds of mono 16 kHz PCM speech generated for this project's tests using macOS Tingting at 160 words per minute, then decoded and trimmed with FFmpeg. Source text: `你终于来了。我等了很久，现在出发吧。` The fixture contains the first five seconds.

The application does not invoke speech synthesis. The fixture lets the real Rhubarb/UI/MCP test run without depending on macOS `say` at test time. Rhubarb and FFmpeg remain explicit test prerequisites.
