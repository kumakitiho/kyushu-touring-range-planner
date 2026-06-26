import L, { type CircleMarker, type LatLngExpression, type Map as LeafletMap, type Polyline } from "leaflet";
import {
  Bike,
  Bot,
  ChevronDown,
  Clock,
  Crosshair,
  ImageOff,
  LocateFixed,
  MapPin,
  Route,
  Search,
  Utensils
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { circlePolygon } from "./lib/geo";
import { probeCodexBackend, type CodexBackendStatus } from "./lib/codexCapability";
import { requestPlans } from "./lib/planClient";
import { routeAtProgress, routeHead } from "./lib/routeAnimation";
import type { GenerationMode, HighwayMode, Plan, PlanRequest, PlanResponse, PlanStop, PreferenceLevel, Spot } from "./shared/types";

type SheetView = "setup" | "plans" | "detail";
type GeoState = "idle" | "requesting" | "granted" | "denied" | "unavailable" | "timeout" | "low_accuracy";
type SheetMode = "peek" | "mid" | "full";
type CodexStatus = CodexBackendStatus;
type CodexLoginStart = {
  type: "chatgptDeviceCode" | "chatgpt" | "unavailable";
  loginId?: string;
  verificationUrl?: string;
  userCode?: string;
  authUrl?: string;
  message?: string;
};

const presets = [
  { label: "福岡・天神", lat: 33.5902, lng: 130.4017 },
  { label: "熊本駅", lat: 32.7907, lng: 130.6889 },
  { label: "大分駅", lat: 33.2334, lng: 131.6067 },
  { label: "宮崎駅", lat: 31.9155, lng: 131.4316 },
  { label: "鹿児島中央駅", lat: 31.5836, lng: 130.5411 }
];

type Origin = PlanRequest["origin"];

const defaultOrigin: Origin = { ...presets[0], source: "preset" };

const defaultPreferences: PlanRequest["preferences"] = {
  gourmet: "medium",
  scenic: "medium",
  road: "medium",
  relaxed: "low"
};

const highwayOptions: Array<{ value: HighwayMode; label: string; hint: string }> = [
  { value: "none", label: "高速なし", hint: "有料道路を避ける" },
  { value: "full", label: "高速あり", hint: "遠方候補も含める" }
];

const generationOptions: Array<{ value: GenerationMode; label: string; hint: string }> = [
  { value: "auto", label: "おすすめ", hint: "条件を見て精度重視で提案" },
  { value: "codex", label: "高精度提案", hint: "条件の読み取りを強める" },
  { value: "local", label: "登録データ", hint: "収集済みスポットだけで提案" }
];

const loadingMessages = [
  "景色と食事のバランスを見ています",
  "同じ方面で回りやすい順番を整えています",
  "往復走行の目安を確認しています",
  "今日の寄り道候補を絞っています"
];

export function App() {
  const [origin, setOrigin] = useState(defaultOrigin);
  const [constraintType, setConstraintType] = useState<"distance" | "duration">("duration");
  const [constraintValue, setConstraintValue] = useState(240);
  const [highwayMode, setHighwayMode] = useState<HighwayMode>("none");
  const [preferences, setPreferences] = useState<PlanRequest["preferences"]>(defaultPreferences);
  const [tripStyle, setTripStyle] = useState<"half_day" | "day_trip">("day_trip");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("auto");
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexBackendAvailable, setCodexBackendAvailable] = useState<boolean | null>(null);
  const [codexLogin, setCodexLogin] = useState<CodexLoginStart | null>(null);
  const [isCodexLoginLoading, setIsCodexLoginLoading] = useState(false);
  const [planResponse, setPlanResponse] = useState<PlanResponse | null>(null);
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0);
  const [selectedSpot, setSelectedSpot] = useState<PlanStop | null>(null);
  const [sheetView, setSheetView] = useState<SheetView>("setup");
  const [sheetMode, setSheetMode] = useState<SheetMode>("mid");
  const [geoState, setGeoState] = useState<GeoState>("idle");
  const [message, setMessage] = useState("地図をタップすると手動で出発地点を置けます。");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const mapElement = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const activeLineRef = useRef<Polyline | null>(null);
  const headMarkerRef = useRef<CircleMarker | null>(null);
  const spotMarkerRefs = useRef<Map<string, CircleMarker>>(new Map());
  const animationRef = useRef<number | null>(null);
  const planResponseRef = useRef<PlanResponse | null>(null);
  const sheetDragMovedRef = useRef(false);
  const startedAtRef = useRef<number>(0);
  const routeProgressRef = useRef(1);
  const fittedPlanKeyRef = useRef<string>("");

  const selectedPlan = planResponse?.plans[selectedPlanIndex] ?? null;
  const activeSpotId = selectedSpot?.spotId ?? selectedPlan?.stops[0]?.spotId ?? null;

  function invalidateGeneratedPlans() {
    const hadPlan = Boolean(planResponseRef.current);
    planResponseRef.current = null;
    setPlanResponse(null);
    setSelectedPlanIndex(0);
    setSelectedSpot(null);
    setSheetView("setup");
    setIsPlaying(false);
    routeProgressRef.current = 1;
    fittedPlanKeyRef.current = "";
    if (hadPlan) setMessage("条件が変わりました。ルートを再提案してください。");
  }

  function changeOrigin(nextOrigin: Origin) {
    invalidateGeneratedPlans();
    setOrigin(nextOrigin);
  }

  useEffect(() => {
    let active = true;
    void probeCodexBackend().then((status) => {
      if (!active) return;
      setCodexBackendAvailable(status !== null);
      if (status) {
        setCodexStatus(status);
      } else {
        setGenerationMode("local");
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isLoading) {
      setLoadingStep(0);
      return;
    }
    const timer = window.setInterval(() => {
      setLoadingStep((step) => (step + 1) % loadingMessages.length);
    }, 1300);
    return () => window.clearInterval(timer);
  }, [isLoading]);

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return;
    const map = L.map(mapElement.current, {
      zoomControl: false,
      attributionControl: false
    }).setView([origin.lat, origin.lng], 8);

    L.control.zoom({ position: "topright" }).addTo(map);
    L.control
      .attribution({ position: "bottomright", prefix: false })
      .addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>')
      .addTo(map);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19
    }).addTo(map);

    map.on("click", (event) => {
      const nextOrigin = {
        label: "地図で指定した地点",
        lat: Number(event.latlng.lat.toFixed(6)),
        lng: Number(event.latlng.lng.toFixed(6)),
        source: "manual" as const
      };
      changeOrigin(nextOrigin);
      setMessage("地図タップで出発地点を更新しました。");
    });

    mapRef.current = map;
    layersRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
  }, [origin.lat, origin.lng]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;
    layers.clearLayers();
    spotMarkerRefs.current.clear();

    const originIcon = L.divIcon({
      className: "origin-marker",
      html: '<span>出発</span>',
      iconSize: [58, 30],
      iconAnchor: [29, 30]
    });
    L.marker([origin.lat, origin.lng], { icon: originIcon }).addTo(layers);

    if (!planResponse) {
      const previewCoordinates = circlePolygon([origin.lat, origin.lng], previewRadiusKm(constraintType, constraintValue, highwayMode, tripStyle, preferences.relaxed));
      L.polygon(previewCoordinates as LatLngExpression[], {
        color: "#2563eb",
        weight: 1,
        opacity: 0.52,
        dashArray: "6 8",
        fillColor: "#60a5fa",
        fillOpacity: 0.09,
        interactive: false
      }).addTo(layers);
    } else if (planResponse.reachableArea.coordinates.length) {
      L.polygon(planResponse.reachableArea.coordinates as LatLngExpression[], {
        color: "#0284c7",
        weight: 1,
        opacity: 0.8,
        fillColor: "#38bdf8",
        fillOpacity: 0.12
      }).addTo(layers);
    }

    planResponse?.candidates.forEach((spot) => {
      const isPlanStop = selectedPlan?.stops.some((stop) => stop.spotId === spot.id) ?? false;
      const isActive = activeSpotId === spot.id;
      const marker = L.circleMarker([spot.lat, spot.lng], {
        radius: isActive ? 13 : isPlanStop ? 8 : 5,
        color: categoryColor(spot.category),
        fillColor: categoryColor(spot.category),
        fillOpacity: isActive ? 1 : 0.9,
        weight: isActive ? 5 : 2,
        opacity: isActive ? 1 : 0.9
      })
        .bindPopup(spotPopupHtml(spot))
        .on("click", () => {
          const planStop = selectedPlan?.stops.find((stop) => stop.spotId === spot.id);
          if (planStop) setSelectedSpot(planStop);
        })
        .addTo(layers);
      spotMarkerRefs.current.set(spot.id, marker);
    });

    if (activeSpotId) spotMarkerRefs.current.get(activeSpotId)?.openPopup();

    const fitKey = selectedPlan ? mapFitKey(selectedPlan, sheetMode) : "";
    if (selectedPlan?.routeLine.length && fittedPlanKeyRef.current !== fitKey) {
      map.fitBounds(L.latLngBounds(selectedPlan.routeLine as LatLngExpression[]), {
        paddingTopLeft: [32, 72],
        paddingBottomRight: [32, sheetMode === "full" ? 500 : 330],
        maxZoom: 10
      });
      fittedPlanKeyRef.current = fitKey;
    }
  }, [origin, planResponse, selectedPlan, sheetMode, activeSpotId, constraintType, constraintValue, highwayMode, tripStyle, preferences.relaxed]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedSpot) return;
    flyToSpotInVisibleMapArea(map, [selectedSpot.lat, selectedSpot.lng], sheetMode);
    spotMarkerRefs.current.get(selectedSpot.spotId)?.openPopup();
  }, [selectedSpot, sheetMode]);

  function selectItinerarySpot(spot: PlanStop) {
    setSelectedSpot(spot);
    if (sheetMode === "full") setSheetMode("mid");
  }

  function flyToSpotInVisibleMapArea(map: LeafletMap, spot: LatLngExpression, mode: SheetMode) {
    const zoom = Math.max(map.getZoom(), 10);
    const mapRect = map.getContainer().getBoundingClientRect();
    const sheetRect = document.querySelector(".bottom-sheet")?.getBoundingClientRect();
    const isBottomSheet =
      sheetRect &&
      sheetRect.width > mapRect.width * 0.8 &&
      sheetRect.top < mapRect.bottom &&
      sheetRect.bottom > mapRect.top;

    if (!isBottomSheet) {
      map.flyTo(spot, zoom, {
        animate: true,
        duration: 0.75
      });
      return;
    }

    const sheetHeight = Math.max(0, mapRect.bottom - sheetRect.top);
    const topPadding = 84;
    const effectiveSheetHeight = mode === "full" ? mapRect.height * 0.46 : sheetHeight;
    const bottomPadding = mode === "peek" ? Math.min(effectiveSheetHeight, mapRect.height * 0.28) : effectiveSheetHeight;
    const visibleBottom = Math.max(topPadding + 120, mapRect.height - bottomPadding);
    const targetY = (topPadding + visibleBottom) / 2;
    const spotPoint = map.project(spot, zoom);
    const adjustedCenterPoint = L.point(spotPoint.x, spotPoint.y + mapRect.height / 2 - targetY);
    const adjustedCenter = map.unproject(adjustedCenterPoint, zoom);

    map.flyTo(adjustedCenter, zoom, {
      animate: true,
      duration: 0.75
    });
  }

  useEffect(() => {
    const routeLayer = routeLayerRef.current;
    if (!routeLayer) return;
    routeLayer.clearLayers();
    activeLineRef.current = null;
    headMarkerRef.current = null;
    if (!selectedPlan?.routeLine.length) return;

    L.polyline(selectedPlan.routeLine as LatLngExpression[], {
      color: "#0f172a",
      weight: 3,
      opacity: 0.22,
      dashArray: "8 10",
      interactive: false
    }).addTo(routeLayer);

    activeLineRef.current = L.polyline([], {
      color: "#2563eb",
      weight: 7,
      opacity: 0.92,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
      smoothFactor: 1.5
    }).addTo(routeLayer);

    headMarkerRef.current = L.circleMarker(selectedPlan.routeLine[0], {
      radius: 8,
      color: "#eff6ff",
      fillColor: "#2563eb",
      fillOpacity: 1,
      weight: 4,
      interactive: false
    }).addTo(routeLayer);

    drawRouteFrame(routeProgressRef.current);
  }, [selectedPlan]);

  useEffect(() => {
    if (!isPlaying || !selectedPlan) return;
    startedAtRef.current = performance.now() - routeProgressRef.current * 4200;
    const tick = (time: number) => {
      const next = Math.min(1, (time - startedAtRef.current) / 4200);
      routeProgressRef.current = next;
      drawRouteFrame(next);
      if (next < 1) {
        animationRef.current = requestAnimationFrame(tick);
      } else {
        setIsPlaying(false);
      }
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, selectedPlan]);

  async function generatePlans() {
    setIsLoading(true);
    setLoadingStep(0);
    setMessage("プランを組み立てています。");
    const request: PlanRequest = {
      origin,
      constraint:
        constraintType === "distance"
          ? { type: "distance", value: constraintValue, unit: "km" }
          : { type: "duration", value: constraintValue, unit: "min" },
      routeOptions: { highwayMode },
      preferences,
      tripStyle,
      count: 3,
      generationMode
    };

    try {
      const data = await requestPlans(request);
      planResponseRef.current = data;
      setPlanResponse(data);
      setSelectedPlanIndex(0);
      setSelectedSpot(data.plans[0]?.stops[0] ?? null);
      fittedPlanKeyRef.current = "";
      routeProgressRef.current = 0;
      setSheetView("plans");
      setSheetMode("mid");
      setIsPlaying(true);
      setCodexStatus(data.providerStatus ? { ...data.providerStatus } : codexStatus);
      setMessage(messageForPlanResponse(data));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ルート提案に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshCodexStatus(showMessage = true) {
    const data = await probeCodexBackend();
    if (data) {
      setCodexBackendAvailable(true);
      setCodexStatus(data);
      if (showMessage) setMessage(statusMessage(data));
    } else {
      const unavailable = { codexAvailable: false, authMode: null, planType: null, message: "高精度提案の状態を確認できませんでした。" };
      setCodexBackendAvailable(false);
      setGenerationMode("local");
      setCodexStatus(unavailable);
      if (showMessage) setMessage(unavailable.message);
    }
  }

  async function startCodexLogin() {
    setIsCodexLoginLoading(true);
    setMessage("高精度提案のログインを開始しています。");
    try {
      const response = await fetch("/api/codex/login/start", { method: "POST" });
      const data = (await response.json()) as CodexLoginStart;
      setCodexLogin(data);
      if (data.type === "unavailable") {
        setMessage(data.message || "高精度提案のログインを開始できませんでした。");
      } else {
        setMessage("表示された手順でChatGPTログインを完了してください。");
      }
    } catch {
      setMessage("高精度提案のログインを開始できませんでした。");
    } finally {
      setIsCodexLoginLoading(false);
    }
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setGeoState("unavailable");
      setMessage("このブラウザでは現在地を取得できません。手動指定を使ってください。");
      return;
    }
    setGeoState("requesting");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const accuracy = position.coords.accuracy;
        changeOrigin({
          label: accuracy > 1000 ? "現在地付近" : "現在地",
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
          source: "gps"
        });
        setGeoState(accuracy > 1000 ? "low_accuracy" : "granted");
        setMessage(accuracy > 1000 ? "現在地を取得しましたが精度は低めです。" : "現在地を出発地点にしました。");
        mapRef.current?.setView([position.coords.latitude, position.coords.longitude], 10);
      },
      (error) => {
        const nextState = error.code === error.TIMEOUT ? "timeout" : error.code === error.PERMISSION_DENIED ? "denied" : "unavailable";
        setGeoState(nextState);
        setMessage("現在地を取得できませんでした。地図タップかプリセットで指定してください。");
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 120000 }
    );
  }

  function selectPlan(plan: Plan, index: number) {
    setSelectedPlanIndex(index);
    setSelectedSpot(plan.stops[0] ?? null);
    fittedPlanKeyRef.current = "";
    routeProgressRef.current = 0;
    setIsPlaying(true);
  }

  function drawRouteFrame(progress: number) {
    const line = selectedPlan?.routeLine ?? [];
    const activeLine = activeLineRef.current;
    const headMarker = headMarkerRef.current;
    if (!line.length || !activeLine || !headMarker) return;
    const visible = routeAtProgress(line, progress);
    activeLine.setLatLngs(visible as LatLngExpression[]);
    const head = routeHead(visible);
    if (head) headMarker.setLatLng(head);
  }

  function startSheetDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const startY = event.clientY;
    const startMode = sheetMode;
    sheetDragMovedRef.current = false;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientY - startY;
      if (shouldSuppressSheetClick(delta)) sheetDragMovedRef.current = true;
      if (delta < -70) setSheetMode("full");
      if (delta > 70) setSheetMode(startMode === "full" ? "mid" : "peek");
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
  }

  const shouldShowStatus =
    isLoading ||
    geoState !== "idle" ||
    message.includes("失敗") ||
    message.includes("できません") ||
    message.includes("ログイン") ||
    (message.includes("地図上") || message.includes("地図タップ")) ||
    message.includes("条件が変わりました") ||
    message.includes("登録スポット");

  return (
    <main className="app-shell">
      <section className="map-stage" aria-label="ツーリングマップ">
        <div ref={mapElement} className="map-canvas" />
        {isLoading && (
          <div className="loading-overlay" role="status" aria-live="polite">
            <div className="loading-spinner" />
            <strong>ルート提案中</strong>
            <span>{loadingMessages[loadingStep]}</span>
          </div>
        )}
      </section>

      <section className={`bottom-sheet ${sheetMode}`} aria-label="プラン操作パネル">
        <button
          className="sheet-handle"
          onPointerDown={startSheetDrag}
          onClick={() => {
            if (sheetDragMovedRef.current) {
              sheetDragMovedRef.current = false;
              return;
            }
            setSheetMode(sheetMode === "full" ? "mid" : "full");
          }}
        >
          <span />
          <ChevronDown size={18} />
        </button>
        <div className="journey-bar">
          <div>
            <span className="journey-kicker">{sheetView === "setup" ? "今日の条件" : sheetView === "plans" ? "候補から選ぶ" : "ルートの流れ"}</span>
            <strong>{selectedPlan ? selectedPlan.title : `${origin.label}から`}</strong>
            <small>
              {formatConstraint(constraintType, constraintValue)} / {highwayLabel(highwayMode)}
            </small>
          </div>
          <div className="journey-actions">
            {sheetView !== "setup" && (
              <button onClick={() => setSheetView("setup")} type="button">
                条件
              </button>
            )}
            {planResponse && sheetView !== "plans" && (
              <button onClick={() => setSheetView("plans")} type="button">
                候補
              </button>
            )}
            <SheetCollapseButton mode={sheetMode} onCollapse={() => setSheetMode("mid")} />
          </div>
        </div>
        {shouldShowStatus && (
          <div className="status-line" role="status" aria-live="polite">
            {message}
          </div>
        )}

        <div className="sheet-content">
          {sheetView === "setup" && (
            <InputPanel
              origin={origin}
              geoState={geoState}
              constraintType={constraintType}
              constraintValue={constraintValue}
              highwayMode={highwayMode}
              preferences={preferences}
              tripStyle={tripStyle}
              generationMode={generationMode}
              codexStatus={codexStatus}
              codexBackendAvailable={codexBackendAvailable}
              codexLogin={codexLogin}
              onUseCurrentLocation={useCurrentLocation}
              onPickOriginOnMap={() => {
                setSheetMode("peek");
                setMessage("地図上の出発地点をタップしてください。");
              }}
              onOriginChange={changeOrigin}
              onConstraintTypeChange={(type) => {
                invalidateGeneratedPlans();
                setConstraintType(type);
              }}
              onConstraintValueChange={(value) => {
                invalidateGeneratedPlans();
                setConstraintValue(value);
              }}
              onHighwayModeChange={(mode) => {
                invalidateGeneratedPlans();
                setHighwayMode(mode);
              }}
              onPreferencesChange={(nextPreferences) => {
                invalidateGeneratedPlans();
                setPreferences(nextPreferences);
              }}
              onTripStyleChange={(style) => {
                invalidateGeneratedPlans();
                setTripStyle(style);
              }}
              onGenerationModeChange={(mode) => {
                invalidateGeneratedPlans();
                setGenerationMode(mode);
              }}
              onStartCodexLogin={startCodexLogin}
              onRefreshCodexStatus={() => refreshCodexStatus(true)}
              isCodexLoginLoading={isCodexLoginLoading}
            />
          )}
          {sheetView === "plans" && (
            <PlanList
              response={planResponse}
              selectedIndex={selectedPlanIndex}
              onSelectPlan={selectPlan}
              onSelectSpot={(spot, plan, index) => {
                selectPlan(plan, index);
                setSelectedSpot(spot);
                setSheetView("detail");
              }}
            />
          )}
          {sheetView === "detail" && <PlanItinerary plan={selectedPlan} selectedSpot={selectedSpot} onSelectSpot={selectItinerarySpot} />}
        </div>
        <button className="generate-button sheet-primary" onClick={generatePlans} disabled={isLoading}>
          <Search size={21} />
          {isLoading ? "提案中" : "ルートを提案"}
        </button>
      </section>
    </main>
  );
}

export function SheetCollapseButton(props: { mode: SheetMode; onCollapse: () => void }) {
  if (props.mode !== "full") return null;
  return (
    <button
      className="sheet-collapse-button"
      onClick={props.onCollapse}
      type="button"
      aria-label="シートを縮める"
      title="シートを縮める"
    >
      <ChevronDown size={20} />
    </button>
  );
}

export function shouldSuppressSheetClick(deltaY: number) {
  return Math.abs(deltaY) > 8;
}

export function mapFitKey(plan: Plan, mode: SheetMode) {
  return `${planKey(plan)}:${mode}`;
}

export function InputPanel(props: {
  origin: Origin;
  geoState: GeoState;
  constraintType: "distance" | "duration";
  constraintValue: number;
  highwayMode: HighwayMode;
  preferences: PlanRequest["preferences"];
  tripStyle: "half_day" | "day_trip";
  generationMode: GenerationMode;
  codexStatus: CodexStatus | null;
  codexBackendAvailable: boolean | null;
  codexLogin: CodexLoginStart | null;
  onUseCurrentLocation: () => void;
  onPickOriginOnMap: () => void;
  onOriginChange: (origin: Origin) => void;
  onConstraintTypeChange: (type: "distance" | "duration") => void;
  onConstraintValueChange: (value: number) => void;
  onHighwayModeChange: (mode: HighwayMode) => void;
  onPreferencesChange: (preferences: PlanRequest["preferences"]) => void;
  onTripStyleChange: (style: "half_day" | "day_trip") => void;
  onGenerationModeChange: (mode: GenerationMode) => void;
  onStartCodexLogin: () => void;
  onRefreshCodexStatus: () => void;
  isCodexLoginLoading: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div className="trip-setup">
      <aside className="location-disclosure">
        本アプリは現在地を保存しません。地図表示では
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
        へ、道路ルートの計算では
        <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noreferrer">Valhalla</a>
        へ座標が送信され、運営側のログに保存される場合があります。
        <a href="https://www.fossgis.de/datenschutzerklaerung/" target="_blank" rel="noreferrer">プライバシー・利用条件</a>
        <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">地図の誤りを報告</a>
        <a href="mailto:s.kuma100ten@gmail.com">s.kuma100ten@gmail.com</a>
      </aside>
      <section className="trip-condition-card">
        <div className="origin-strip">
          <div className="origin-dot">
            <MapPin size={18} />
          </div>
          <div>
            <span>出発</span>
            <strong>{props.origin.label}</strong>
          </div>
          <div className="origin-actions">
            <button className="locate-chip" onClick={props.onUseCurrentLocation} type="button">
              <LocateFixed size={17} />
              {props.geoState === "requesting" ? "取得中" : "現在地"}
            </button>
            <button className="locate-chip map-pick-chip" onClick={props.onPickOriginOnMap} type="button">
              <Crosshair size={17} />
              地図
            </button>
          </div>
        </div>

        <div className="range-hero">
          <div>
            <span>{props.constraintType === "duration" ? "往復走行の目安" : "往復距離の目安"}</span>
            <strong>{formatRangeValue(props.constraintType, props.constraintValue)}</strong>
            {props.constraintType === "duration" && <small>{props.constraintValue}分</small>}
          </div>
          <div className="range-switch icon-toggle" role="group" aria-label="走行条件の指定方法">
            <button
              aria-label="走行時間で指定"
              aria-pressed={props.constraintType === "duration"}
              className={props.constraintType === "duration" ? "active" : ""}
              onClick={() => props.onConstraintTypeChange("duration")}
              type="button"
              title="走行時間で指定"
            >
              <Clock size={19} />
            </button>
            <button
              aria-label="走行距離で指定"
              aria-pressed={props.constraintType === "distance"}
              className={props.constraintType === "distance" ? "active" : ""}
              onClick={() => props.onConstraintTypeChange("distance")}
              type="button"
              title="走行距離で指定"
            >
              <Bike size={19} />
            </button>
          </div>
        </div>

        <label className="range-label compact">
          <input
            type="range"
            min={props.constraintType === "duration" ? 90 : 60}
            max={props.constraintType === "duration" ? 600 : 420}
            step={props.constraintType === "duration" ? 30 : 20}
            value={props.constraintValue}
            onChange={(event) => props.onConstraintValueChange(Number(event.target.value))}
          />
        </label>

        <div className="quick-prefs">
          <span>景色: {preferenceLevelLabel(props.preferences.scenic)}</span>
          <span>食事: {preferenceLevelLabel(props.preferences.gourmet)}</span>
        </div>

      </section>

      <button
        className="details-toggle"
        onClick={() => setDetailsOpen((open) => !open)}
        type="button"
        aria-expanded={detailsOpen}
        aria-controls="trip-detail-options"
      >
        <span>こだわり条件</span>
        <ChevronDown size={18} className={detailsOpen ? "open" : ""} />
      </button>

      {detailsOpen && (
        <div className="details-panel" id="trip-detail-options">
          <section>
            <div className="section-title compact-title">
              <Crosshair size={18} />
              <h2>出発地プリセット</h2>
            </div>
            <div className="preset-grid route-pills">
              {presets.map((preset) => (
                <button key={preset.label} onClick={() => props.onOriginChange({ ...preset, source: "preset" })} type="button">
                  {preset.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="section-title compact-title">
              <Route size={18} />
              <h2>高速道路</h2>
            </div>
            <div className="segmented highway-grid">
              {highwayOptions.map((option) => (
                <button
                  key={option.value}
                  className={props.highwayMode === option.value ? "active" : ""}
                  onClick={() => props.onHighwayModeChange(option.value)}
                  type="button"
                >
                  <strong>{option.label}</strong>
                  <span>{option.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="section-title compact-title">
              <Bike size={18} />
              <h2>好み</h2>
            </div>
            <PreferenceSegment label="景色" value={props.preferences.scenic} labels={["少なめ", "ほどよく", "重視"]} onChange={(scenic) => props.onPreferencesChange({ ...props.preferences, scenic })} />
            <PreferenceSegment label="グルメ" value={props.preferences.gourmet} labels={["軽め", "ほどよく", "重視"]} onChange={(gourmet) => props.onPreferencesChange({ ...props.preferences, gourmet })} />
            <PreferenceSegment label="余裕" value={props.preferences.relaxed} labels={["詰める", "標準", "ゆったり"]} onChange={(relaxed) => props.onPreferencesChange({ ...props.preferences, relaxed })} />
            <div className="segmented soft-segment">
              <button className={props.tripStyle === "half_day" ? "active" : ""} onClick={() => props.onTripStyleChange("half_day")} type="button">
                半日
              </button>
              <button className={props.tripStyle === "day_trip" ? "active" : ""} onClick={() => props.onTripStyleChange("day_trip")} type="button">
                日帰り
              </button>
            </div>
          </section>

          <section className="diagnostic-panel">
            <div className="section-title compact-title">
              <Bot size={18} />
              <h2>提案方法</h2>
            </div>
            {props.codexBackendAvailable === false ? (
              <p className="local-proposal-note">公開版では登録済みスポットから提案します。</p>
            ) : props.codexBackendAvailable === true ? (
              <>
                <div className="segmented generation-grid">
                  {generationOptions.map((option) => (
                    <button
                      key={option.value}
                      className={props.generationMode === option.value ? "active" : ""}
                      onClick={() => props.onGenerationModeChange(option.value)}
                      type="button"
                    >
                      <strong>{generationLabel(option.value)}</strong>
                      <span>{option.hint}</span>
                    </button>
                  ))}
                </div>
                <div className="codex-card">
                  <div>
                    <strong>{codexStatusLabel(props.codexStatus)}</strong>
                    <span>{codexStatusDetail(props.codexStatus)}</span>
                  </div>
                  <div className="codex-actions">
                    <button className="small-button" onClick={props.onRefreshCodexStatus} type="button">
                      更新
                    </button>
                    <button className="small-button primary" onClick={props.onStartCodexLogin} disabled={props.isCodexLoginLoading} type="button">
                      {props.isCodexLoginLoading ? "開始中" : "ログイン"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p className="local-proposal-note">提案方法を確認しています。</p>
            )}
            {props.codexBackendAvailable === true && props.codexLogin?.type === "chatgptDeviceCode" && (
              <div className="login-card">
                <span>以下のURLでコードを入力</span>
                <a href={props.codexLogin.verificationUrl} target="_blank" rel="noreferrer">
                  {props.codexLogin.verificationUrl}
                </a>
                <strong>{props.codexLogin.userCode}</strong>
              </div>
            )}
            {props.codexBackendAvailable === true && props.codexLogin?.type === "chatgpt" && (
              <div className="login-card">
                <span>ブラウザでChatGPTログイン</span>
                <a href={props.codexLogin.authUrl} target="_blank" rel="noreferrer">
                  ログイン画面を開く
                </a>
              </div>
            )}
          </section>

        </div>
      )}
    </div>
  );
}

function PreferenceSegment(props: {
  label: string;
  value: PreferenceLevel;
  labels: [string, string, string];
  onChange: (value: PreferenceLevel) => void;
}) {
  const values: PreferenceLevel[] = ["low", "medium", "high"];
  return (
    <div className="preference-control">
      <span>{props.label}</span>
      <div className="preference-segment" role="group" aria-label={props.label}>
        {values.map((value, index) => (
          <button key={value} className={props.value === value ? "active" : ""} onClick={() => props.onChange(value)} type="button">
            {props.labels[index]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PlanList(props: {
  response: PlanResponse | null;
  selectedIndex: number;
  onSelectPlan: (plan: Plan, index: number) => void;
  onSelectSpot: (spot: PlanStop, plan: Plan, index: number) => void;
}) {
  if (!props.response) {
    return (
      <div className="empty-state">
        <Bike size={34} />
        <p>条件を入れてプランを生成すると、ここに候補が表示されます。</p>
      </div>
    );
  }

  if (props.response.plans.length === 0) {
    return (
      <div className="empty-state">
        <MapPin size={34} />
        <p>この条件内で立ち寄り候補が見つかりませんでした。時間や距離を広げるか、出発地点を変えてください。</p>
      </div>
    );
  }

  return (
    <div className="plan-list">
      <div className="candidate-intro">
        <strong>{props.response.plans.length}つの候補</strong>
        <span>{props.response.fallbackReason ? "登録スポットから候補を整えました" : "地図上のルートと合わせて選べます"}</span>
      </div>
      {props.response.fallbackReason && props.response.providerStatus?.codexAvailable !== false && (
        <details className="plan-diagnostic">
          <summary>提案メモ</summary>
          <p>高精度提案の結果が使えなかったため、登録データから提案しました。</p>
        </details>
      )}
      {props.response.plans.map((plan, index) => (
        <article key={plan.title} className={`plan-card ${props.selectedIndex === index ? "selected" : ""}`}>
          <button className="plan-main" onClick={() => props.onSelectPlan(plan, index)}>
            <div className="plan-copy">
              <div className="plan-metrics">
                <span>{plan.estimatedDistanceKm}km</span>
                <span>約{Math.round(plan.estimatedDurationMin / 10) * 10}分</span>
                <span>{plan.highwayUsage}</span>
              </div>
              <h2>{plan.title}</h2>
              <p className="plan-appeal">{plan.appeal || plan.summary}</p>
              <div className="best-for compact-tags">
                {planComparisonTags(plan).map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </div>
          </button>
          <div className="stop-row">
            {plan.stops.map((stop) => (
              <button key={stop.spotId} onClick={() => props.onSelectSpot(stop, plan, index)}>
                {categoryIcon(stop.category)}
                {stop.name}
              </button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

export function PlanItinerary(props: { plan: Plan | null; selectedSpot: PlanStop | null; onSelectSpot: (spot: PlanStop) => void }) {
  if (!props.plan) {
    return (
      <div className="empty-state">
        <ImageOff size={34} />
        <p>プラン内の立ち寄り先を選ぶと画像と詳細が見られます。</p>
      </div>
    );
  }
  const activeSpot = props.selectedSpot ?? props.plan.stops[0] ?? null;
  return (
    <article className="spot-detail">
      <div className="spot-copy">
        <p className="category-label">{props.plan.estimatedDistanceKm}km / 約{Math.round(props.plan.estimatedDurationMin / 10) * 10}分</p>
        <h2>{props.plan.title}</h2>
        <p className="route-story">{props.plan.routeStory}</p>
        <div className="itinerary-list">
          {props.plan.stops.map((spot, index) => (
            <button
              key={spot.spotId}
              className={activeSpot?.spotId === spot.spotId ? "active" : ""}
              onClick={() => props.onSelectSpot(spot)}
              type="button"
            >
              <span>{index + 1}</span>
              <div>
                <strong>{spot.name}</strong>
                <small>{categoryLabel(spot.category)} / {spot.area} / {spot.timeHint}</small>
              </div>
            </button>
          ))}
        </div>
        {activeSpot && (
          <>
            <div className="itinerary-notes">
              <section>
                <strong>名物</strong>
                <p>{activeSpot.famousFor}</p>
              </section>
              <section>
                <strong>ここで何する</strong>
                <p>{activeSpot.whyStopHere}</p>
              </section>
              <section>
                <strong>走る人向け</strong>
                <p>{activeSpot.riderNote}</p>
              </section>
              <section>
                <strong>滞在</strong>
                <p>{activeSpot.recommendedAction}</p>
              </section>
            </div>
            <div className="preference-fit">
              {activeSpot.matchedPreferences.slice(0, 2).map((preference) => (
                <span key={preference}>{preferenceLabel(preference)}</span>
              ))}
              <span>{activeSpot.timeHint}</span>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function messageForPlanResponse(response: PlanResponse) {
  if (response.fallbackReason) return "登録スポットから候補を整えました。";
  return "候補を地図に表示しました。";
}

function previewRadiusKm(
  type: "distance" | "duration",
  value: number,
  highwayMode: HighwayMode,
  tripStyle: "half_day" | "day_trip",
  relaxed: PreferenceLevel
) {
  const tripStyleBuffer = tripStyle === "half_day" ? 0.72 : 1;
  const budgetDistance =
    type === "distance"
      ? value * tripStyleBuffer
      : speedForHighwayMode(highwayMode) * (value / 60) * (relaxed === "high" ? 0.82 : 0.9) * tripStyleBuffer;
  return Math.max(8, budgetDistance / 2.4);
}

function speedForHighwayMode(mode: HighwayMode) {
  return mode === "full" ? 68 : 43;
}

function formatRangeValue(type: "distance" | "duration", value: number) {
  if (type === "distance") return `${value}km`;
  const hours = value / 60;
  if (Number.isInteger(hours)) return `約${hours}時間`;
  const wholeHours = Math.floor(hours);
  const minutes = value % 60;
  return wholeHours > 0 ? `約${wholeHours}時間${minutes}分` : `約${minutes}分`;
}

function planComparisonTags(plan: Plan) {
  const tags: string[] = [];
  const categories = new Set(plan.stops.map((stop) => stop.category));
  if (categories.has("scenic")) tags.push("景色向き");
  if (categories.has("gourmet")) tags.push("食事あり");
  if (categories.has("rest")) tags.push("休憩あり");
  if (plan.routeSource === "fallback") tags.push("簡易ルート");
  if (plan.stops.length >= 3) tags.push("寄り道多め");
  if (plan.estimatedDurationMin <= 150) tags.push("短め");
  if (plan.estimatedDurationMin >= 240) tags.push("しっかり");
  return tags.slice(0, 4);
}

export function spotPopupHtml(spot: Spot) {
  const image = spot.images[0];
  const imageHtml = image
    ? `<img class="map-popup-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt || spot.name)}" loading="lazy" />`
    : "";
  const creditHtml = image
    ? `<a class="map-popup-credit" href="${escapeHtml(image.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(image.credit)} / ${escapeHtml(image.license)}</a>`
    : "";
  return `
    <article class="map-popup-card">
      ${imageHtml}
      <div class="map-popup-copy">
        <span>${escapeHtml(categoryLabel(spot.category))} / ${escapeHtml(spot.area)}</span>
        <strong>${escapeHtml(spot.name)}</strong>
        <p>${escapeHtml(spot.description)}</p>
        ${creditHtml}
      </div>
    </article>
  `;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatConstraint(type: "distance" | "duration", value: number) {
  return type === "duration" ? `往復走行 ${formatRangeValue(type, value)}` : `往復距離 約${value}km`;
}

function highwayLabel(mode: HighwayMode) {
  return highwayOptions.find((option) => option.value === mode)?.label ?? "高速道路";
}

function generationLabel(mode: GenerationMode) {
  if (mode === "codex") return "高精度提案";
  if (mode === "local") return "登録データ";
  return "おすすめ";
}

function preferenceLevelLabel(level: PreferenceLevel) {
  if (level === "high") return "重視";
  if (level === "low") return "控えめ";
  return "ほどよく";
}

function statusMessage(status: CodexStatus) {
  if (!status.codexAvailable) return status.message || "高精度提案を利用できません。";
  if (status.authMode === "chatgpt") return `高精度提案を利用できます${status.planType ? `（${status.planType}）` : ""}。`;
  return "未ログイン時は登録データで提案します。";
}

function codexStatusLabel(status: CodexStatus | null) {
  if (!status) return "提案機能を確認中";
  if (!status.codexAvailable) return "高精度提案は利用不可";
  if (status.authMode === "chatgpt") return "高精度提案を利用可能";
  return "登録データで提案";
}

function codexStatusDetail(status: CodexStatus | null) {
  if (!status) return "自動モードは確認後に利用します";
  if (!status.codexAvailable) return status.message || "高精度提案を起動できません";
  if (status.authMode === "chatgpt") return status.planType ? `ChatGPT ${status.planType}` : "ChatGPT認証";
  return "ログインなしでも登録データで使えます";
}

function preferenceLabel(preference: keyof PlanRequest["preferences"]) {
  switch (preference) {
    case "gourmet":
      return "グルメに合う";
    case "scenic":
      return "景色に合う";
    case "road":
      return "走りに合う";
    case "relaxed":
      return "ゆったりに合う";
  }
}

function categoryColor(category: string) {
  switch (category) {
    case "gourmet":
      return "#dc2626";
    case "scenic":
      return "#16a34a";
    case "road":
      return "#2563eb";
    case "rest":
      return "#2563eb";
    default:
      return "#0f172a";
  }
}

function categoryLabel(category: string) {
  switch (category) {
    case "gourmet":
      return "グルメ";
    case "scenic":
      return "景勝地";
    case "road":
      return "快走ポイント";
    case "rest":
      return "休憩";
    default:
      return "スポット";
  }
}

function categoryIcon(category: string) {
  if (category === "gourmet") return <Utensils size={15} />;
  if (category === "scenic") return <MapPin size={15} />;
  if (category === "rest") return <Crosshair size={15} />;
  return <Bike size={15} />;
}

function planKey(plan: Plan): string {
  return `${plan.title}:${plan.routeLine.length}:${plan.stops.map((stop) => stop.spotId).join(">")}`;
}
