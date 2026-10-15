import { ExternalLink, Globe, Music2, Radio } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, containerLabel, containerTone, Dot, ErrorBox, Kv, PageHeader, Skeleton, StatusBadge } from '../components/ui';
import { ago, bytes, pct } from '../lib/format';
import { byType, useContainers, useIntegrations, useResource } from '../lib/queries';

type Info = { api: number; version: string | null; name: string | null; publicUrl: string | null; capabilities: string[] };

export function ArmonyPage() {
  const ints = useIntegrations();
  const containers = useContainers();
  const armony = byType(ints.data, 'armony');
  const nd = byType(ints.data, 'navidrome');
  const info = useResource<Info>(armony, 'info', '', 60_000);
  const scan = useResource<{ supported: boolean; scanning?: boolean; count?: number; lastScan?: string }>(nd, 'scan', '', 60_000);
  const stack = (containers.data ?? []).filter((c) => c.composeProject === 'armony');

  return (
    <div>
      <PageHeader
        title="Armony"
        description="La tua app musicale e il suo stack. GIGI OS osserva e basta: Armony funziona anche se GIGI OS è spento."
        actions={
          armony && (
            <a href={armony.webUrl} target="_blank" rel="noreferrer noopener">
              <Button size="sm">
                Apri Armony <ExternalLink />
              </Button>
            </a>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Armony" icon={<Music2 />} actions={armony && <StatusBadge status={armony.status} />}>
          {!armony ? (
            <p className="text-xs text-muted">
              Integrazione non presente. <Link to="/integrazioni?add=armony" className="text-accent hover:underline">Aggiungila</Link>.
            </p>
          ) : info.isError ? (
            <ErrorBox error={info.error} compact />
          ) : !info.data ? (
            <Skeleton className="h-24" />
          ) : (
            <dl>
              <Kv k="Istanza">{info.data.name ?? '—'}</Kv>
              <Kv k="Versione">{info.data.version ?? '—'}</Kv>
              <Kv k="API">v{info.data.api}</Kv>
              <Kv k="Indirizzo pubblico">
                {info.data.publicUrl ? (
                  <span className="inline-flex items-center gap-1">
                    <Globe className="size-3.5 text-warn" /> {info.data.publicUrl}
                  </span>
                ) : (
                  '—'
                )}
              </Kv>
              <Kv k="Latenza">{armony.latency !== null ? `${armony.latency} ms` : '—'}</Kv>
            </dl>
          )}
        </Card>
        <Card title="Navidrome" icon={<Radio />} actions={nd && <StatusBadge status={nd.status} />}>
          {!nd ? (
            <p className="text-xs text-muted">Integrazione non presente.</p>
          ) : (
            <dl>
              <Kv k="Endpoint">{nd.baseUrl}</Kv>
              <Kv k="Stato">{nd.message ?? '—'}</Kv>
              <Kv k="Scansione">
                {scan.data?.supported ? (
                  <>
                    {scan.data.scanning ? <Badge tone="info">in corso</Badge> : 'inattiva'} · {scan.data.count ?? 0} brani · {ago(scan.data.lastScan ?? null)}
                  </>
                ) : (
                  <span className="text-muted">servono credenziali Subsonic</span>
                )}
              </Kv>
            </dl>
          )}
          <p className="mt-3 text-[11px] text-muted">Relazione preservata: armony-app → armony-navidrome. GIGI OS non modifica né la libreria né il database di Navidrome.</p>
        </Card>
        <Card title="Stack Docker «armony»">
          {containers.isError && <ErrorBox error={containers.error} compact />}
          {!containers.data && !containers.isError && <Skeleton className="h-24" />}
          <ul className="space-y-1.5">
            {stack.map((c) => (
              <li key={c.id}>
                <Link to={`/docker?c=${encodeURIComponent(c.name)}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-surface-2">
                  <Dot tone={containerTone(c.state, c.health)} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-[11px] text-muted tabular">
                    {c.stats ? `${pct(c.stats.cpu, 1)} · ${bytes(c.stats.memUsed, 0)}` : containerLabel(c.state, c.health)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
        {info.data && (
          <Card title={`Capability dichiarate (${info.data.capabilities.length})`} className="lg:col-span-3" subtitle="Lette da /api/info. Integrazioni più profonde solo dopo aver verificato le API reali di Armony.">
            <div className="flex flex-wrap gap-1">
              {info.data.capabilities.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
