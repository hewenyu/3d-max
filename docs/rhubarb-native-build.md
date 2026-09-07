# Rhubarb On Apple Silicon

Rhubarb Lip Sync 1.14.0's published macOS binary is x86_64. On this ARM Mac it reports `bad CPU type in executable` without Rosetta. The official source builds natively; no Rosetta or Java runtime is required when building only the CLI target.

Reproduced with AppleClang 17, CMake 4.4.3 and Boost 1.92.0:

```sh
brew install cmake boost
git clone --depth 1 --branch v1.14.0 --recurse-submodules https://github.com/DanielSWolf/rhubarb-lip-sync.git .data/tools/rhubarb-native/source
cmake -S .data/tools/rhubarb-native/source -B .data/tools/rhubarb-native/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DBOOST_ROOT=/opt/homebrew
cmake --build .data/tools/rhubarb-native/build --target rhubarb --config Release --parallel 4
.data/tools/rhubarb-native/build/rhubarb/rhubarb --version
```

The release tag resolves to commit `9b9573cd21b253c9ba58739bbd1aa0b50b991bff`. CMake copies the required `res/` models beside the CLI in `build/rhubarb/`; keep that directory together when relocating it. The executable is Mach-O 64-bit arm64 and reports `Rhubarb Lip Sync version 1.14.0`.

Actual verification used the official release's `extras/AdobeAfterEffects/demo/riddle.wav` with `-r phonetic -f json --machineReadable`. It completed successfully for 14.37 seconds of speech, producing 86 mouth cues and all nine extended shapes (`A` through `H`, plus `X`). The output is `.data/tools/rhubarb-native/verification.json`. This verifies the executable and models; application-level persistence, synchronization and rendered facial motion are tested independently.
