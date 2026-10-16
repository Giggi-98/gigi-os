import { useQuery } from '@tanstack/react-query';
import { api, type Container, type ContainerMetrics, type DiskMetrics, type HostMetrics, type Integration, type MetricsRange, type Overview, type Sample, type SystemSnapshot } from './api';

// Polling moderato e solo con la scheda visibile (refetchIntervalInBackground=false di default).
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), refetchInterval: 10_000 });
export const useSystem = () => useQuery({ queryKey: ['system'], queryFn: () => api<SystemSnapshot>('/system'), refetchInterval: 5_000 });
export const useHistory = (minutes = 60) =>
  useQuery({ queryKey: ['history', minutes], queryFn: () => api<Sample[]>(`/system/history?minutes=${minutes}`), refetchInterval: 15_000 });
export const useHostMetrics = (range: MetricsRange, enabled = true) =>
  useQuery({ queryKey: ['metrics', 'host', range], queryFn: () => api<HostMetrics>(`/metrics/host?range=${range}`), refetchInterval: 60_000, enabled });
export const useContainerMetrics = (range: MetricsRange, metric: 'cpu' | 'mem') =>
  useQuery({ queryKey: ['metrics', 'containers', range, metric], queryFn: () => api<ContainerMetrics>(`/metrics/containers?range=${range}&metric=${metric}&top=5`), refetchInterval: 60_000 });
export const useDiskMetrics = () => useQuery({ queryKey: ['metrics', 'disks'], queryFn: () => api<DiskMetrics>('/metrics/disks'), refetchInterval: 300_000 });
export const useContainers = () => useQuery({ queryKey: ['containers'], queryFn: () => api<Container[]>('/docker/containers'), refetchInterval: 10_000 });
export const useIntegrations = () => useQuery({ queryKey: ['integrations'], queryFn: () => api<Integration[]>('/integrations'), refetchInterval: 30_000 });

export function useResource<T>(integration: Integration | undefined, name: string, params = '', interval = 15_000) {
  return useQuery({
    queryKey: ['resource', integration?.id, name, params],
    queryFn: () => api<T>(`/integrations/${integration!.id}/resources/${name}${params ? `?${params}` : ''}`),
    enabled: !!integration && integration.enabled && integration.status !== 'unconfigured',
    refetchInterval: interval,
    retry: 1,
  });
}

export function byType(list: Integration[] | undefined, type: string) {
  return list?.find((i) => i.type === type && i.enabled);
}
