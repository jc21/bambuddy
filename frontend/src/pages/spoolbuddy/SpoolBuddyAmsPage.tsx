import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import type { SpoolBuddyOutletContext } from '../../components/spoolbuddy/SpoolBuddyLayout';
import { api } from '../../api/client';
import type { PrinterStatus, AMSTray } from '../../api/client';
import { getGlobalTrayId, getFillBarColor, getSpoolmanFillLevel, getFallbackSpoolTag } from '../../utils/amsHelpers';
import { AmsUnitCard, HumidityIndicator, TemperatureIndicator, NozzleBadge } from '../../components/spoolbuddy/AmsUnitCard';
import type { AmsThresholds } from '../../components/spoolbuddy/AmsUnitCard';
import { ConfigureAmsSlotModal } from '../../components/ConfigureAmsSlotModal';

function getAmsName(amsId: number): string {
  if (amsId <= 3) return `AMS ${String.fromCharCode(65 + amsId)}`;
  if (amsId >= 128 && amsId <= 135) return `AMS HT ${String.fromCharCode(65 + amsId - 128)}`;
  return `AMS ${amsId}`;
}

function mapModelCode(ssdpModel: string | null): string {
  if (!ssdpModel) return '';
  const modelMap: Record<string, string> = {
    'O1D': 'H2D', 'O1E': 'H2D Pro', 'O2D': 'H2D Pro', 'O1C': 'H2C', 'O1C2': 'H2C', 'O1S': 'H2S',
    'BL-P001': 'X1C', 'BL-P002': 'X1', 'BL-P003': 'X1E',
    'C11': 'P1S', 'C12': 'P1P', 'C13': 'P2S',
    'N2S': 'A1', 'N1': 'A1 Mini',
    'X1C': 'X1C', 'X1': 'X1', 'X1E': 'X1E', 'P1S': 'P1S', 'P1P': 'P1P', 'P2S': 'P2S',
    'A1': 'A1', 'A1 Mini': 'A1 Mini', 'H2D': 'H2D', 'H2D Pro': 'H2D Pro', 'H2C': 'H2C', 'H2S': 'H2S',
  };
  return modelMap[ssdpModel] || ssdpModel;
}

function isTrayEmpty(tray: AMSTray): boolean {
  return !tray.tray_type || tray.tray_type === '';
}

function trayColorToCSS(color: string | null): string {
  if (!color) return '#808080';
  return `#${color.slice(0, 6)}`;
}

export function SpoolBuddyAmsPage() {
  const { selectedPrinterId, setAlert } = useOutletContext<SpoolBuddyOutletContext>();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: status } = useQuery<PrinterStatus>({
    queryKey: ['printerStatus', selectedPrinterId],
    queryFn: () => api.getPrinterStatus(selectedPrinterId!),
    enabled: selectedPrinterId !== null,
    staleTime: 30 * 1000,
  });

  const { data: printer } = useQuery({
    queryKey: ['printer', selectedPrinterId],
    queryFn: () => api.getPrinter(selectedPrinterId!),
    enabled: selectedPrinterId !== null,
    staleTime: 60 * 1000,
  });

  const { data: slotPresets } = useQuery({
    queryKey: ['slotPresets', selectedPrinterId],
    queryFn: () => api.getSlotPresets(selectedPrinterId!),
    enabled: selectedPrinterId !== null,
    staleTime: 2 * 60 * 1000,
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
    staleTime: 5 * 60 * 1000,
  });

  // Fetch Spoolman status to enable fill-level chain
  const { data: spoolmanStatus } = useQuery({
    queryKey: ['spoolman-status'],
    queryFn: api.getSpoolmanStatus,
    staleTime: 60 * 1000,
  });
  const spoolmanEnabled = spoolmanStatus?.enabled && spoolmanStatus?.connected;

  // Fetch linked spools map (tag -> spool info) for Spoolman fill levels
  const { data: linkedSpoolsData } = useQuery({
    queryKey: ['linked-spools'],
    queryFn: api.getLinkedSpools,
    enabled: !!spoolmanEnabled,
    staleTime: 30 * 1000,
  });
  const linkedSpools = linkedSpoolsData?.linked;

  const { data: assignments } = useQuery({
    queryKey: ['spool-assignments', selectedPrinterId],
    queryFn: () => api.getAssignments(selectedPrinterId!),
    enabled: selectedPrinterId !== null,
    staleTime: 30 * 1000,
  });

  // Build fill-level override map from inventory assignments
  // Key: "amsId-trayId", Value: fill percentage (0-100)
  const fillOverrides = useMemo(() => {
    const map: Record<string, number> = {};
    if (!assignments) return map;
    for (const a of assignments) {
      const sp = a.spool;
      if (sp && sp.label_weight > 0 && sp.weight_used != null) {
        const fill = Math.round(Math.max(0, sp.label_weight - sp.weight_used) / sp.label_weight * 100);
        map[`${a.ams_id}-${a.tray_id}`] = fill;
      }
    }
    return map;
  }, [assignments]);

  // Look up Spoolman fill level for a given tray
  const printerSerial = printer?.serial_number ?? '';
  const getSpoolmanFillForSlot = useCallback((amsId: number, trayId: number, tray: AMSTray | null): number | null => {
    if (!linkedSpools || !printerSerial) return null;
    const tag = (tray?.tray_uuid || tray?.tag_uid || getFallbackSpoolTag(printerSerial, amsId, trayId))?.toUpperCase();
    const linkedSpool = tag ? linkedSpools[tag] : undefined;
    return getSpoolmanFillLevel(linkedSpool);
  }, [linkedSpools, printerSerial]);

  const isConnected = status?.connected ?? false;

  // Cache AMS data to prevent it disappearing on idle/offline printers
  const cachedAmsData = useRef<PrinterStatus['ams']>([]);
  useEffect(() => {
    if (status?.ams && status.ams.length > 0) {
      cachedAmsData.current = status.ams;
    }
  }, [status?.ams]);
  const amsUnits = useMemo(() => {
    const live = status?.ams;
    return (live && live.length > 0) ? live : (cachedAmsData.current ?? []);
  }, [status?.ams]);
  const regularAms = useMemo(() => amsUnits.filter(u => !u.is_ams_ht), [amsUnits]);
  const htAms = useMemo(() => amsUnits.filter(u => u.is_ams_ht), [amsUnits]);

  // Build Spoolman fill-level override map for regular AMS cards
  const spoolmanFillOverrides = useMemo(() => {
    const map: Record<string, number> = {};
    if (!linkedSpools || !printerSerial) return map;
    for (const unit of regularAms) {
      for (let i = 0; i < (unit.tray?.length ?? 0); i++) {
        const tray = unit.tray![i];
        const fill = getSpoolmanFillForSlot(unit.id, i, isTrayEmpty(tray) ? null : tray);
        if (fill !== null) map[`${unit.id}-${i}`] = fill;
      }
    }
    return map;
  }, [linkedSpools, printerSerial, regularAms, getSpoolmanFillForSlot]);

  // Cache tray_now to prevent flickering when undefined values come in
  // Valid tray IDs: 0-253 for AMS, 254 for external spool
  // tray_now=255 means "no tray loaded" (Bambu protocol sentinel) — never active
  const cachedTrayNow = useRef<number | undefined>(undefined);
  const currentTrayNow = status?.tray_now;
  if (currentTrayNow !== undefined && currentTrayNow !== 255) {
    cachedTrayNow.current = currentTrayNow;
  } else if (currentTrayNow === 255) {
    cachedTrayNow.current = undefined;
  }
  const effectiveTrayNow = (currentTrayNow !== undefined && currentTrayNow !== 255)
    ? currentTrayNow
    : cachedTrayNow.current;
  const isDualNozzle = printer?.nozzle_count === 2 || status?.temperatures?.nozzle_2 !== undefined;
  const vtTrays = useMemo(() => [...(status?.vt_tray ?? [])].sort((a, b) => (a.id ?? 254) - (b.id ?? 254)), [status?.vt_tray]);

  const amsThresholds: AmsThresholds | undefined = settings ? {
    humidityGood: Number(settings.ams_humidity_good) || 40,
    humidityFair: Number(settings.ams_humidity_fair) || 60,
    tempGood: Number(settings.ams_temp_good) || 28,
    tempFair: Number(settings.ams_temp_fair) || 35,
  } : undefined;

  // Cache ams_extruder_map to prevent L/R indicators bouncing on updates
  const cachedAmsExtruderMap = useRef<Record<string, number>>({});
  useEffect(() => {
    if (status?.ams_extruder_map && Object.keys(status.ams_extruder_map).length > 0) {
      cachedAmsExtruderMap.current = status.ams_extruder_map;
    }
  }, [status?.ams_extruder_map]);
  const amsExtruderMap = (status?.ams_extruder_map && Object.keys(status.ams_extruder_map).length > 0)
    ? status.ams_extruder_map
    : cachedAmsExtruderMap.current;

  const getNozzleSide = useCallback((amsId: number): 'L' | 'R' | null => {
    if (!isDualNozzle) return null;
    const mappedExtruderId = amsExtruderMap[String(amsId)];
    const normalizedId = amsId >= 128 ? amsId - 128 : amsId;
    const extruderId = mappedExtruderId !== undefined ? mappedExtruderId : normalizedId;
    // extruder 0 = right, 1 = left
    return extruderId === 1 ? 'L' : 'R';
  }, [isDualNozzle, amsExtruderMap]);

  const [configureSlotModal, setConfigureSlotModal] = useState<{
    amsId: number;
    trayId: number;
    trayCount: number;
    trayType?: string;
    trayColor?: string;
    traySubBrands?: string;
    trayInfoIdx?: string;
    extruderId?: number;
    caliIdx?: number | null;
    savedPresetId?: string;
  } | null>(null);

  const getActiveSlotForAms = useCallback((amsId: number): number | null => {
    if (effectiveTrayNow === undefined) return null;
    if (amsId <= 3) {
      const activeAmsId = Math.floor(effectiveTrayNow / 4);
      if (activeAmsId === amsId) return effectiveTrayNow % 4;
    }
    if (amsId >= 128 && amsId <= 135) {
      // AMS-HT: global tray ID equals the AMS unit ID itself (128, 129, ...)
      if (effectiveTrayNow === getGlobalTrayId(amsId, 0, false)) return 0;
    }
    return null;
  }, [effectiveTrayNow]);

  const handleAmsSlotClick = useCallback((amsId: number, trayId: number, tray: AMSTray | null) => {
    const globalTrayId = amsId >= 128 ? (amsId - 128) * 4 + trayId + 64 : amsId * 4 + trayId;
    const slotPreset = slotPresets?.[globalTrayId];
    const mappedExtruderId = amsExtruderMap[String(amsId)];
    const normalizedId = amsId >= 128 ? amsId - 128 : amsId;
    const extruderId = mappedExtruderId !== undefined ? mappedExtruderId : normalizedId;
    setConfigureSlotModal({
      amsId,
      trayId,
      trayCount: tray ? (amsId >= 128 ? 1 : 4) : 4,
      trayType: tray?.tray_type || undefined,
      trayColor: tray?.tray_color || undefined,
      traySubBrands: tray?.tray_sub_brands || undefined,
      trayInfoIdx: tray?.tray_info_idx || undefined,
      extruderId: isDualNozzle ? extruderId : undefined,
      caliIdx: tray?.cali_idx,
      savedPresetId: slotPreset?.preset_id,
    });
  }, [slotPresets, amsExtruderMap, isDualNozzle]);

  const handleExtSlotClick = useCallback((extTray: AMSTray) => {
    const extTrayId = extTray.id ?? 254;
    const slotTrayId = extTrayId - 254;
    const extSlotPreset = slotPresets?.[255 * 4 + slotTrayId];
    setConfigureSlotModal({
      amsId: 255,
      trayId: slotTrayId,
      trayCount: 1,
      trayType: extTray.tray_type || undefined,
      trayColor: extTray.tray_color || undefined,
      traySubBrands: extTray.tray_sub_brands || undefined,
      trayInfoIdx: extTray.tray_info_idx || undefined,
      extruderId: isDualNozzle ? (extTrayId === 254 ? 1 : 0) : undefined,
      caliIdx: extTray.cali_idx,
      savedPresetId: extSlotPreset?.preset_id,
    });
  }, [slotPresets, isDualNozzle]);

  // Set alert for low filament in status bar
  useEffect(() => {
    if (!isConnected && selectedPrinterId) {
      setAlert({ type: 'warning', message: t('spoolbuddy.ams.printerDisconnected', 'Printer disconnected') });
      return;
    }
    for (const unit of amsUnits) {
      for (const tray of unit.tray || []) {
        if (tray.remain !== null && tray.remain >= 0 && tray.remain < 15 && tray.tray_type) {
          setAlert({
            type: 'warning',
            message: `Low Filament: ${tray.tray_type} (${getAmsName(unit.id)}) - ${tray.remain}% remaining`,
          });
          return;
        }
      }
    }
    setAlert(null);
  }, [amsUnits, isConnected, selectedPrinterId, setAlert, t]);

  // Build list of single-slot items (AMS-HT + External) for compact rendering
  const singleSlots = useMemo(() => {
    const items: {
      key: string; label: string; tray: AMSTray; isEmpty: boolean; isActive: boolean;
      temp?: number | null; humidity?: number | null; nozzleSide?: 'L' | 'R' | null;
      effectiveFill: number | null;
      onClick: () => void;
    }[] = [];

    for (const unit of htAms) {
      const tray = unit.tray?.[0] || {
        id: 0, tray_color: null, tray_type: '', tray_sub_brands: null,
        tray_id_name: null, tray_info_idx: null, remain: -1, k: null,
        cali_idx: null, tag_uid: null, tray_uuid: null, nozzle_temp_min: null, nozzle_temp_max: null,
      };
      // Fill level fallback chain: Spoolman → Inventory → AMS remain
      const spoolmanFill = getSpoolmanFillForSlot(unit.id, 0, isTrayEmpty(tray) ? null : tray);
      const invFill = fillOverrides[`${unit.id}-0`] ?? null;
      const amsFill = tray.remain != null && tray.remain >= 0 ? tray.remain : null;
      // If inventory says 0% but AMS reports positive remain, prefer AMS (#676)
      const resolvedInvFill = (invFill === 0 && amsFill !== null && amsFill > 0) ? null : invFill;
      items.push({
        key: `ht-${unit.id}`,
        label: getAmsName(unit.id),
        tray,
        isEmpty: isTrayEmpty(tray),
        isActive: getActiveSlotForAms(unit.id) === 0,
        temp: unit.temp,
        humidity: unit.humidity,
        nozzleSide: getNozzleSide(unit.id),
        effectiveFill: spoolmanFill ?? resolvedInvFill ?? amsFill,
        onClick: () => handleAmsSlotClick(unit.id, 0, isTrayEmpty(tray) ? null : tray),
      });
    }

    for (const extTray of vtTrays) {
      const extTrayId = extTray.id ?? 254;
      // On dual-nozzle (H2C/H2D), tray_now=254 means "external spool"
      // generically — use active_extruder to determine L vs R:
      // extruder 1=left → Ext-L (id=254), extruder 0=right → Ext-R (id=255)
      const isExtActive = isDualNozzle && effectiveTrayNow === 254
        ? (extTrayId === 254 && status?.active_extruder === 1) ||
          (extTrayId === 255 && status?.active_extruder === 0)
        : effectiveTrayNow === extTrayId;
      const extSlotTrayId = extTrayId - 254;
      // Fill level fallback chain: Spoolman → Inventory → AMS remain
      const extSpoolmanFill = getSpoolmanFillForSlot(255, extSlotTrayId, isTrayEmpty(extTray) ? null : extTray);
      const extInvFill = fillOverrides[`255-${extSlotTrayId}`] ?? null;
      const extAmsFill = extTray.remain != null && extTray.remain >= 0 ? extTray.remain : null;
      // If inventory says 0% but AMS reports positive remain, prefer AMS (#676)
      const extResolvedInvFill = (extInvFill === 0 && extAmsFill !== null && extAmsFill > 0) ? null : extInvFill;
      items.push({
        key: `ext-${extTrayId}`,
        label: isDualNozzle
          ? (extTrayId === 254 ? t('printers.extL', 'Ext-L') : t('printers.extR', 'Ext-R'))
          : t('printers.ext', 'Ext'),
        tray: extTray,
        isEmpty: isTrayEmpty(extTray),
        isActive: isExtActive,
        nozzleSide: null,
        effectiveFill: extSpoolmanFill ?? extResolvedInvFill ?? extAmsFill,
        onClick: () => handleExtSlotClick(extTray),
      });
    }

    return items;
  }, [htAms, vtTrays, isDualNozzle, effectiveTrayNow, status?.active_extruder, t, getActiveSlotForAms, getNozzleSide, handleAmsSlotClick, handleExtSlotClick, fillOverrides, getSpoolmanFillForSlot]);

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex-1 min-h-0">
        {!selectedPrinterId ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center text-white/50">
              <p className="text-lg mb-2">{t('spoolbuddy.ams.noPrinter', 'No printer selected')}</p>
              <p className="text-sm">{t('spoolbuddy.ams.selectPrinter', 'Select a printer from the top bar')}</p>
            </div>
          </div>
        ) : !isConnected ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center text-white/50">
              <p className="text-lg mb-2">{t('spoolbuddy.ams.printerDisconnected', 'Printer disconnected')}</p>
            </div>
          </div>
        ) : amsUnits.length === 0 && vtTrays.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="text-center text-white/50">
              <Layers className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="text-lg mb-2">{t('spoolbuddy.ams.noData', 'No AMS detected')}</p>
              <p className="text-sm">{t('spoolbuddy.ams.connectAms', 'Connect an AMS to see filament slots')}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 h-full">
            {/* Regular AMS cards — 4-slot, 2-col grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {regularAms.map((unit) => (
                <AmsUnitCard
                  key={unit.id}
                  unit={unit}
                  activeSlot={getActiveSlotForAms(unit.id)}
                  onConfigureSlot={handleAmsSlotClick}
                  isDualNozzle={isDualNozzle}
                  nozzleSide={getNozzleSide(unit.id)}
                  thresholds={amsThresholds}
                  fillOverrides={fillOverrides}
                  spoolmanFillOverrides={spoolmanFillOverrides}
                />
              ))}
            </div>

            {/* Third row: single-slot cards (AMS-HT + External) — half-width to align with AMS cards */}
            {singleSlots.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {singleSlots.map(({ key, label, tray, isEmpty, isActive, temp, humidity, nozzleSide, effectiveFill, onClick }) => {
                  const color = trayColorToCSS(tray.tray_color);
                  return (
                    <div
                      key={key}
                      className={`bg-bambu-dark-secondary rounded-lg px-3 py-2 cursor-pointer hover:bg-bambu-dark-secondary/80 transition-all flex items-center gap-3 ${isActive ? 'ring-2 ring-bambu-green' : ''}`}
                      onClick={onClick}
                    >
                      {/* Spool */}
                      <div className="relative w-10 h-10 flex-shrink-0">
                        {isEmpty ? (
                          <div className="w-full h-full rounded-full border-2 border-dashed border-gray-500 flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-gray-600" />
                          </div>
                        ) : (
                          <svg viewBox="0 0 56 56" className="w-full h-full">
                            <circle cx="28" cy="28" r="26" fill={color} />
                            <circle cx="28" cy="28" r="20" fill={color} style={{ filter: 'brightness(0.85)' }} />
                            <ellipse cx="20" cy="20" rx="6" ry="4" fill="white" opacity="0.3" />
                            <circle cx="28" cy="28" r="8" fill="#2d2d2d" />
                            <circle cx="28" cy="28" r="5" fill="#1a1a1a" />
                          </svg>
                        )}
                        {isActive && (
                          <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-bambu-green rounded-full" />
                        )}
                      </div>
                      {/* Info */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-white/50 font-medium truncate">{label}</span>
                          {nozzleSide && <NozzleBadge side={nozzleSide} />}
                        </div>
                        <div className="text-sm text-white/80 truncate">
                          {isEmpty ? 'Empty' : tray.tray_type || '?'}
                        </div>
                        {(temp != null || humidity != null) && (
                          <div className="flex items-center gap-1.5">
                            {temp != null && (
                              <TemperatureIndicator
                                temp={temp}
                                goodThreshold={amsThresholds?.tempGood}
                                fairThreshold={amsThresholds?.tempFair}
                              />
                            )}
                            {humidity != null && (
                              <HumidityIndicator
                                humidity={humidity}
                                goodThreshold={amsThresholds?.humidityGood}
                                fairThreshold={amsThresholds?.humidityFair}
                              />
                            )}
                          </div>
                        )}
                      </div>
                      {/* Fill bar */}
                      {!isEmpty && effectiveFill != null && effectiveFill >= 0 && (
                        <div className="w-1.5 h-8 bg-bambu-dark-tertiary rounded-full overflow-hidden flex-shrink-0 flex flex-col-reverse">
                          <div
                            className="w-full rounded-full"
                            style={{
                              height: `${effectiveFill}%`,
                              backgroundColor: getFillBarColor(effectiveFill),
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {configureSlotModal && selectedPrinterId && (
        <ConfigureAmsSlotModal
          isOpen={!!configureSlotModal}
          onClose={() => setConfigureSlotModal(null)}
          printerId={selectedPrinterId}
          slotInfo={configureSlotModal}
          printerModel={mapModelCode(printer?.model ?? null) || undefined}
          fullScreen
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['slotPresets', selectedPrinterId] });
            queryClient.invalidateQueries({ queryKey: ['printerStatus', selectedPrinterId] });
          }}
        />
      )}
    </div>
  );
}
