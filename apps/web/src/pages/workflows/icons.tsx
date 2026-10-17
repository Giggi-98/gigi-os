// Icone dei blocchi: il catalogo dell'API indica il nome, qui c'è solo l'elenco usato (niente import di tutta la libreria).
import {
  Bell,
  CalendarClock,
  Clapperboard,
  Container,
  CopyX,
  Download,
  Funnel,
  GitBranch,
  Globe,
  Hourglass,
  PenLine,
  Play,
  RefreshCw,
  Rss,
  ScanLine,
  ScrollText,
  Search,
  Send,
  Split,
  UserCheck,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  Bell,
  CalendarClock,
  Clapperboard,
  Container,
  CopyX,
  Download,
  Funnel,
  GitBranch,
  Globe,
  Hourglass,
  PenLine,
  Play,
  RefreshCw,
  Rss,
  ScanLine,
  ScrollText,
  Search,
  Send,
  Split,
  UserCheck,
  Webhook,
  Zap,
};

export function NodeIcon({ name, className }: { name: string; className?: string }) {
  const I = ICONS[name] ?? Zap;
  return <I className={className} aria-hidden />;
}
