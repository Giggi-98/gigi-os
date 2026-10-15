// Analisi tecnica con ffprobe (processo esterno, argomenti come array: nessuna shell, nessuna interpolazione).
import { execFile } from 'node:child_process';

export type Probe = {
  ok: boolean;
  error?: string;
  duration: number | null;
  container: string | null;
  video: { codec: string; width: number; height: number; hdr: boolean } | null;
  audio: { codec: string; lang: string | null; channels: number | null; title: string | null }[];
  subtitles: { codec: string; lang: string | null; forced: boolean; title: string | null }[];
  /** titolo interno al file: solo informativo, NON affidabile per identificare il contenuto */
  embeddedTitle: string | null;
};

const FFPROBE = process.env.GIGI_FFPROBE ?? 'ffprobe';

export function probe(file: string): Promise<Probe> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', file],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: String(err.message).slice(0, 300), duration: null, container: null, video: null, audio: [], subtitles: [], embeddedTitle: null });
          return;
        }
        try {
          const j = JSON.parse(stdout) as {
            format?: { duration?: string; format_name?: string; tags?: Record<string, string> };
            streams?: {
              codec_type: string;
              codec_name?: string;
              width?: number;
              height?: number;
              channels?: number;
              color_transfer?: string;
              disposition?: { forced?: number; attached_pic?: number };
              tags?: Record<string, string>;
            }[];
          };
          const streams = j.streams ?? [];
          const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
          const lang = (t?: Record<string, string>) => t?.language ?? t?.LANGUAGE ?? null;
          resolve({
            ok: true,
            duration: j.format?.duration ? Math.round(Number(j.format.duration)) : null,
            container: j.format?.format_name ?? null,
            video: v ? { codec: v.codec_name ?? '?', width: v.width ?? 0, height: v.height ?? 0, hdr: /smpte2084|arib-std-b67/.test(v.color_transfer ?? '') } : null,
            audio: streams
              .filter((s) => s.codec_type === 'audio')
              .map((s) => ({ codec: s.codec_name ?? '?', lang: lang(s.tags), channels: s.channels ?? null, title: s.tags?.title ?? null })),
            subtitles: streams
              .filter((s) => s.codec_type === 'subtitle')
              .map((s) => ({ codec: s.codec_name ?? '?', lang: lang(s.tags), forced: !!s.disposition?.forced, title: s.tags?.title ?? null })),
            embeddedTitle: j.format?.tags?.title ?? j.format?.tags?.TITLE ?? null,
          });
        } catch (e) {
          resolve({ ok: false, error: 'output ffprobe non valido', duration: null, container: null, video: null, audio: [], subtitles: [], embeddedTitle: null });
        }
      },
    );
  });
}
