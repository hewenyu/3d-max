import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SpeechCatalog, SpeechRequest, SpeechVoice } from '../shared/speech';
import { ApiError } from './errors';

const exec = promisify(execFile);
export interface SpeechRuntime {
  catalog(): Promise<SpeechCatalog>;
  synthesize(request: SpeechRequest): Promise<{ bytes: Buffer; duration: number }>;
}
interface RuntimeOptions {
  platform?: NodeJS.Platform;
  sayPath?: string;
  espeakPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

function sayVoices(output: string): SpeechVoice[] {
  return output.split('\n').flatMap((line) => {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(line);
    return match
      ? [{ id: match[1].trim(), name: match[1].trim(), language: match[2].replace('_', '-') }]
      : [];
  });
}
function espeakVoices(output: string): SpeechVoice[] {
  return output.split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return /^\d+$/.test(fields[0]) && fields.length >= 5
      ? [{ id: fields[4], name: fields[3].replaceAll('_', ' '), language: fields[1] }]
      : [];
  });
}

export function createSpeechRuntime(options: RuntimeOptions = {}): SpeechRuntime {
  const platform = options.platform ?? process.platform;
  const sayPath = options.sayPath ?? process.env.WHITEFRAME_SAY_PATH ?? '/usr/bin/say';
  const espeakPath = options.espeakPath ?? process.env.WHITEFRAME_ESPEAK_PATH ?? 'espeak-ng';
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? 'ffprobe';
  const catalog = async (): Promise<SpeechCatalog> => {
    const engines: SpeechCatalog['engines'] = [];
    for (const id of ['say', 'espeak-ng'] as const) {
      const name = id === 'say' ? 'macOS Say' : 'eSpeak NG';
      try {
        if (id === 'say' && platform !== 'darwin') throw new Error('macOS Say requires macOS');
        const { stdout } = await exec(
          id === 'say' ? sayPath : espeakPath,
          id === 'say' ? ['-v', '?'] : ['--voices'],
          { timeout: 10000, maxBuffer: 1024 * 1024 },
        );
        const voices = id === 'say' ? sayVoices(stdout) : espeakVoices(stdout);
        if (!voices.length) throw new Error('No installed voices were reported');
        engines.push({ id, name, available: true, voices });
      } catch (error) {
        engines.push({
          id,
          name,
          available: false,
          voices: [],
          diagnostic: `${(error as Error).message}. ${id === 'say' ? 'Configure WHITEFRAME_SAY_PATH on macOS and install system voices.' : 'Install espeak-ng or configure WHITEFRAME_ESPEAK_PATH.'}`,
        });
      }
    }
    let encoding: SpeechCatalog['encoding'] = { available: true };
    try {
      await exec(ffmpeg, ['-version'], { timeout: 5000 });
      await exec(ffprobe, ['-version'], { timeout: 5000 });
    } catch {
      encoding = {
        available: false,
        diagnostic: 'Install FFmpeg and ffprobe and make both executables available on PATH.',
      };
    }
    return {
      available: encoding.available && engines.some((engine) => engine.available),
      engines,
      encoding,
      limits: { textCharacters: 5000, durationSeconds: 300, rate: { min: 80, max: 350, default: 180 } },
    };
  };
  return {
    catalog,
    async synthesize(request) {
      const capabilities = await catalog();
      const engine = capabilities.engines.find((item) => item.id === request.engine)!;
      if (!engine.available)
        throw new ApiError('TTS_UNAVAILABLE', engine.diagnostic ?? 'Speech engine is unavailable', 503);
      if (!capabilities.encoding.available)
        throw new ApiError('TTS_ENCODING_UNAVAILABLE', capabilities.encoding.diagnostic!, 503);
      if (!engine.voices.some((voice) => voice.id === request.voice))
        throw new ApiError(
          'TTS_VOICE_UNAVAILABLE',
          'The requested voice is not installed; refresh speech_catalog',
          422,
        );
      const directory = await mkdtemp(join(tmpdir(), 'whiteframe-speech-'));
      try {
        const textPath = join(directory, 'dialogue.txt');
        const generated = join(directory, request.engine === 'say' ? 'voice.aiff' : 'voice.wav');
        const output = join(directory, 'dialogue.wav');
        await writeFile(textPath, request.text, 'utf8');
        const args =
          request.engine === 'say'
            ? ['-v', request.voice, '-r', String(request.rate), '-f', textPath, '-o', generated]
            : ['-v', request.voice, '-s', String(request.rate), '-f', textPath, '-w', generated];
        await exec(request.engine === 'say' ? sayPath : espeakPath, args, {
          timeout: 180000,
          maxBuffer: 1024 * 1024,
        });
        await exec(
          ffmpeg,
          [
            '-v',
            'error',
            '-y',
            '-i',
            generated,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '48000',
            '-map_metadata',
            '-1',
            '-c:a',
            'pcm_s16le',
            output,
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        const { stdout } = await exec(
          ffprobe,
          ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output],
          { timeout: 15000 },
        );
        const probe = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: { codec_type: string }[];
        };
        const duration = Number(probe.format?.duration);
        if (
          !probe.streams?.some((stream) => stream.codec_type === 'audio') ||
          !Number.isFinite(duration) ||
          duration <= 0
        )
          throw new ApiError('TTS_INVALID_AUDIO', 'Speech engine did not produce decodable audio', 422);
        if (duration > 300)
          throw new ApiError(
            'TTS_AUDIO_TOO_LONG',
            'Generated dialogue exceeds 300 seconds; split the dialogue into shorter beats',
            422,
          );
        return { bytes: await readFile(output), duration };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('TTS_FAILED', `Speech synthesis failed: ${(error as Error).message}`, 422);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

export const speechCatalog = () => createSpeechRuntime().catalog();
