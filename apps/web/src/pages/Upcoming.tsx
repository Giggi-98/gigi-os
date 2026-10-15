import { Construction } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Badge, Card, PageHeader } from '../components/ui';

const MODULES: Record<string, { title: string; phase: string; points: string[] }> = {
  'media-automation': {
    title: 'Media automation',
    phase: 'V3',
    points: [
      'Rilevamento dei download completati e stabili in qBittorrent',
      'Analisi con ffprobe/MediaInfo e parsing del nome file (film, serie, anime, speciali/OVA)',
      'Matching metadati TMDb/AniList con punteggio di confidenza e motivazione',
      'Coda di revisione per i casi ambigui; importazione automatica solo sopra soglia',
      'Hardlink verso /srv/media per non interrompere il seeding, mai cancellazioni',
      'Scansione mirata Jellyfin via API e verifica dell’indicizzazione',
    ],
  },
  file: {
    title: 'File manager',
    phase: 'V4',
    points: ['Solo directory consentite, protezione da path traversal e symlink', 'Vista dedicata alle librerie media', 'Conferme e anteprima per operazioni multiple'],
  },
  automazioni: {
    title: 'Automazioni',
    phase: 'V4',
    points: ['Regole evento → condizioni → azioni', 'Coda persistente, retry, deduplicazione e storico', 'Editor visuale in una fase successiva'],
  },
  backup: {
    title: 'Backup',
    phase: 'V4',
    points: ['Backup del database GIGI OS e delle configurazioni dei servizi', 'Verifica e ripristino guidato'],
  },
};

export function UpcomingPage() {
  const { id = '' } = useParams();
  const m = MODULES[id];
  if (!m) return <PageHeader title="Modulo non trovato" />;
  return (
    <div>
      <PageHeader title={m.title} description="Modulo pianificato: non ancora implementato." actions={<Badge tone="accent">previsto in {m.phase}</Badge>} />
      <Card>
        <div className="flex gap-4">
          <Construction className="mt-0.5 size-6 shrink-0 text-muted" />
          <div>
            <p className="mb-2 text-[13px] text-fg-2">Questa sezione non esegue ancora alcuna operazione. Cosa farà:</p>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
              {m.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}
