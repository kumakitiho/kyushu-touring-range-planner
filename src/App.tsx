import L, { type CircleMarker, type LatLngExpression, type Map as LeafletMap, type Polyline } from "leaflet";
import {
  Bike,
  Bot,
  ChevronDown,
  Crosshair,
  ImageOff,
  LocateFixed,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  Route,
  Search,
  Utensils
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { routeAtProgress, routeHead } from "./lib/routeAnimation";
import type { GenerationMode, HighwayMode, Plan, PlanRequest, PlanResponse, PlanStop, PreferenceLevel } from "./shared/types";

type Tab = "input" | "plans" | "spot";
type GeoState = "idle" | "requesting" | "granted" | "denied" | "unavailable" | "timeout" | "low_accuracy";
type SheetMode = "peek" | "mid" | "full";
type CodexStatus = {
  codexAvailable: boolean;
  authMode: string | null;
  planType: string | null;
  loginState?: string;
  message?: string;
};
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
  road: "high",
  relaxed: "low"
};

const highwayOptions: Array<{ value: HighwayMode; label: string; hint: string }> = [
  { value: "none", label: "下道のみ", hint: "近場と快走路を優先" },
  { value: "full", label: "高速あり", hint: "遠方候補も出す" },
  { value: "outbound_only", label: "行きだけ高速", hint: "帰りはゆっくり" },
  { value: "return_only", label: "帰りだけ高速", hint: "帰宅を楽に" },
  { value: "local_only_after_highway", label: "現地は下道", hint: "ワープして走る" }
];

const generationOptions: Array<{ value: GenerationMode; label: string; hint: string }> = [
  { value: "auto", label: "自動", hint: "Codex優先、失敗時ローカル" },
  { value: "codex", label: "Codex", hint: "ChatGPT枠で候補選定" },
  { value: "local", label: "ローカル", hint: "収集済みJSONのみ" }
];

const loadingMessages = [
  "条件に合う候補スポットを絞り込んでいます",
  "同じ方面にまとまる立ち寄り順を見ています",
  "道路ルートと所要時間を確認しています",
  "好みに合う理由と旅程メモを整えています"
];

export function App() {
  const [origin, setOrigin] = useState(defaultOrigin);
  const [constraintType, setConstraintType] = useState<"distance" | "duration">("duration");
  const [constraintValue, setConstraintValue] = useState(240);
  const [highwayMode, setHighwayMode] = useState<HighwayMode>("local_only_after_highway");
  const [preferences, setPreferences] = useState<PlanRequest["preferences"]>(defaultPreferences);
  const [tripStyle, setTripStyle] = useState<"half_day" | "day_trip">("day_trip");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("auto");
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexLogin, setCodexLogin] = useState<CodexLoginStart | null>(null);
  const [isCodexLoginLoading, setIsCodexLoginLoading] = useState(false);
  const [planResponse, setPlanResponse] = useState<PlanResponse | null>(null);
  const [selectedPlanIndex, setSelectedPlanIndex] = useState(0);
  const [selectedSpot, setSelectedSpot] = useState<PlanStop | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("input");
  const [sheetMode, setSheetMode] = useState<SheetMode>("mid");
  const [geoState, setGeoState] = useState<GeoState>("idle");
  const [message, setMessage] = useState("地図をタップすると手動で出発地点を置けます。");
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [routeProgress, setRouteProgress] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);

  const mapElement = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const activeLineRef = useRef<Polyline | null>(null);
  const headMarkerRef = useRef<CircleMarker | null>(null);
  const animationRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const routeProgressRef = useRef(1);
  const fittedPlanKeyRef = useRef<string>("");

  const selectedPlan = planResponse?.plans[selectedPlanIndex] ?? null;
  const activeSpotId = selectedSpot?.spotId ?? selectedPlan?.stops[0]?.spotId ?? null;

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
      .addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
      .addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19
    }).addTo(map);

    map.on("click", (event) => {
      const nextOrigin = {
        label: "地図で指定した地点",
        lat: Number(event.latlng.lat.toFixed(6)),
        lng: Number(event.latlng.lng.toFixed(6)),
        source: "manual" as const
      };
      setOrigin(nextOrigin);
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

    const originIcon = L.divIcon({
      className: "origin-marker",
      html: '<span>出発</span>',
      iconSize: [58, 30],
      iconAnchor: [29, 30]
    });
    L.marker([origin.lat, origin.lng], { icon: originIcon }).addTo(layers);

    if (planResponse?.reachableArea.coordinates.length) {
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
      L.circleMarker([spot.lat, spot.lng], {
        radius: isActive ? 13 : isPlanStop ? 8 : 5,
        color: categoryColor(spot.category),
        fillColor: categoryColor(spot.category),
        fillOpacity: isActive ? 1 : 0.9,
        weight: isActive ? 5 : 2,
        opacity: isActive ? 1 : 0.9
      })
        .bindPopup(`<strong>${spot.name}</strong><br>${spot.area}<br>${spot.description}`)
        .addTo(layers);
    });

    if (selectedPlan?.routeLine.length && fittedPlanKeyRef.current !== planKey(selectedPlan)) {
      map.fitBounds(L.latLngBounds(selectedPlan.routeLine as LatLngExpression[]), {
        paddingTopLeft: [32, 72],
        paddingBottomRight: [32, sheetMode === "full" ? 420 : 260],
        maxZoom: 10
      });
      fittedPlanKeyRef.current = planKey(selectedPlan);
    }
  }, [origin, planResponse, selectedPlan, sheetMode, activeSpotId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedSpot) return;
    map.flyTo([selectedSpot.lat, selectedSpot.lng], Math.max(map.getZoom(), 10), {
      animate: true,
      duration: 0.75
    });
  }, [selectedSpot]);

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
      color: "#f97316",
      weight: 7,
      opacity: 0.92,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
      smoothFactor: 1.5
    }).addTo(routeLayer);

    headMarkerRef.current = L.circleMarker(selectedPlan.routeLine[0], {
      radius: 8,
      color: "#fff7ed",
      fillColor: "#ea580c",
      fillOpacity: 1,
      weight: 4,
      interactive: false
    }).addTo(routeLayer);

    drawRouteFrame(routeProgress);
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
        setRouteProgress(1);
        setIsPlaying(false);
      }
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, selectedPlan]);

  useEffect(() => {
    if (!isPlaying) drawRouteFrame(routeProgress);
  }, [routeProgress, isPlaying, selectedPlan]);

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
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request)
      });
      if (!response.ok) throw new Error("プラン生成に失敗しました。");
      const data = (await response.json()) as PlanResponse;
      setPlanResponse(data);
      setSelectedPlanIndex(0);
      setSelectedSpot(data.plans[0]?.stops[0] ?? null);
      fittedPlanKeyRef.current = "";
      routeProgressRef.current = 0;
      setActiveTab("plans");
      setSheetMode("mid");
      setRouteProgress(0);
      setIsPlaying(true);
      setCodexStatus(data.providerStatus ? { ...data.providerStatus } : codexStatus);
      setMessage(messageForPlanResponse(data));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "プラン生成に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshCodexStatus(showMessage = true) {
    try {
      const response = await fetch("/api/codex/status");
      const data = (await response.json()) as CodexStatus;
      setCodexStatus(data);
      if (showMessage) setMessage(statusMessage(data));
    } catch {
      const unavailable = { codexAvailable: false, authMode: null, planType: null, message: "Codex状態を確認できませんでした。" };
      setCodexStatus(unavailable);
      if (showMessage) setMessage(unavailable.message);
    }
  }

  async function startCodexLogin() {
    setIsCodexLoginLoading(true);
    setMessage("Codexログインを開始しています。");
    try {
      const response = await fetch("/api/codex/login/start", { method: "POST" });
      const data = (await response.json()) as CodexLoginStart;
      setCodexLogin(data);
      if (data.type === "unavailable") {
        setMessage(data.message || "Codexログインを開始できませんでした。");
      } else {
        setMessage("表示された手順でChatGPTログインを完了してください。");
      }
    } catch {
      setMessage("Codexログインを開始できませんでした。");
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
        setOrigin({
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

  function replayRoute() {
    routeProgressRef.current = 0;
    setRouteProgress(0);
    drawRouteFrame(0);
    setIsPlaying(true);
  }

  function selectPlan(plan: Plan, index: number) {
    setSelectedPlanIndex(index);
    setSelectedSpot(plan.stops[0] ?? null);
    fittedPlanKeyRef.current = "";
    routeProgressRef.current = 0;
    setRouteProgress(0);
    setIsPlaying(true);
  }

  function toggleRoutePlayback() {
    if (isPlaying) {
      setRouteProgress(routeProgressRef.current);
      setIsPlaying(false);
      return;
    }
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
    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientY - startY;
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

  return (
    <main className="app-shell">
      <section className="map-stage" aria-label="ツーリングマップ">
        <div ref={mapElement} className="map-canvas" />
        {isLoading && (
          <div className="loading-overlay" role="status" aria-live="polite">
            <div className="loading-spinner" />
            <strong>プラン生成中</strong>
            <span>{loadingMessages[loadingStep]}</span>
          </div>
        )}
        <div className="top-bar">
          <div>
            <p className="eyebrow">Kyushu Touring</p>
            <h1>九州ツーリングレンジプランナー</h1>
          </div>
          <button className="icon-button" onClick={useCurrentLocation} aria-label="現在地を使う">
            <LocateFixed size={21} />
          </button>
        </div>
        <div className="route-controls" aria-label="ルート再生操作">
          <button className="control-button" onClick={toggleRoutePlayback} disabled={!selectedPlan}>
            {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            <span>{isPlaying ? "停止" : "再生"}</span>
          </button>
          <button className="control-button" onClick={replayRoute} disabled={!selectedPlan}>
            <RotateCcw size={20} />
            <span>リプレイ</span>
          </button>
          <button className="control-button primary" onClick={generatePlans} disabled={isLoading}>
            <Search size={20} />
            <span>{isLoading ? "生成中" : "プラン生成"}</span>
          </button>
        </div>
      </section>

      <section className={`bottom-sheet ${sheetMode}`} aria-label="プラン操作パネル">
        <button className="sheet-handle" onPointerDown={startSheetDrag} onClick={() => setSheetMode(sheetMode === "full" ? "mid" : "full")}>
          <span />
          <ChevronDown size={18} />
        </button>
        <div className="status-line">{message}</div>
        <nav className="tabs" aria-label="表示切替">
          <button className={activeTab === "input" ? "active" : ""} onClick={() => setActiveTab("input")}>
            条件
          </button>
          <button className={activeTab === "plans" ? "active" : ""} onClick={() => setActiveTab("plans")}>
            提案
          </button>
          <button className={activeTab === "spot" ? "active" : ""} onClick={() => setActiveTab("spot")}>
            旅程
          </button>
        </nav>

        <div className="sheet-content">
          {activeTab === "input" && (
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
              codexLogin={codexLogin}
              onUseCurrentLocation={useCurrentLocation}
              onOriginChange={setOrigin}
              onConstraintTypeChange={setConstraintType}
              onConstraintValueChange={setConstraintValue}
              onHighwayModeChange={setHighwayMode}
              onPreferencesChange={setPreferences}
              onTripStyleChange={setTripStyle}
              onGenerationModeChange={setGenerationMode}
              onStartCodexLogin={startCodexLogin}
              onRefreshCodexStatus={() => refreshCodexStatus(true)}
              onGenerate={generatePlans}
              isLoading={isLoading}
              isCodexLoginLoading={isCodexLoginLoading}
            />
          )}
          {activeTab === "plans" && (
            <PlanList
              response={planResponse}
              selectedIndex={selectedPlanIndex}
              onSelectPlan={selectPlan}
              onSelectSpot={(spot, plan, index) => {
                selectPlan(plan, index);
                setSelectedSpot(spot);
                setActiveTab("spot");
              }}
            />
          )}
          {activeTab === "spot" && <PlanItinerary plan={selectedPlan} selectedSpot={selectedSpot} onSelectSpot={setSelectedSpot} />}
        </div>
      </section>
    </main>
  );
}

function InputPanel(props: {
  origin: Origin;
  geoState: GeoState;
  constraintType: "distance" | "duration";
  constraintValue: number;
  highwayMode: HighwayMode;
  preferences: PlanRequest["preferences"];
  tripStyle: "half_day" | "day_trip";
  generationMode: GenerationMode;
  codexStatus: CodexStatus | null;
  codexLogin: CodexLoginStart | null;
  onUseCurrentLocation: () => void;
  onOriginChange: (origin: Origin) => void;
  onConstraintTypeChange: (type: "distance" | "duration") => void;
  onConstraintValueChange: (value: number) => void;
  onHighwayModeChange: (mode: HighwayMode) => void;
  onPreferencesChange: (preferences: PlanRequest["preferences"]) => void;
  onTripStyleChange: (style: "half_day" | "day_trip") => void;
  onGenerationModeChange: (mode: GenerationMode) => void;
  onStartCodexLogin: () => void;
  onRefreshCodexStatus: () => void;
  onGenerate: () => void;
  isLoading: boolean;
  isCodexLoginLoading: boolean;
}) {
  return (
    <div className="panel-stack">
      <section className="form-section">
        <div className="section-title">
          <Crosshair size={18} />
          <h2>出発地点</h2>
        </div>
        <button className="wide-button" onClick={props.onUseCurrentLocation}>
          <LocateFixed size={20} />
          {props.geoState === "requesting" ? "現在地を取得中" : "GPS現在地を使う"}
        </button>
        <div className="origin-card">
          <MapPin size={18} />
          <div>
            <strong>{props.origin.label}</strong>
            <span>
              {props.origin.lat.toFixed(4)}, {props.origin.lng.toFixed(4)} / {sourceLabel(props.origin.source)}
            </span>
          </div>
        </div>
        <div className="preset-grid">
          {presets.map((preset) => (
            <button key={preset.label} onClick={() => props.onOriginChange({ ...preset, source: "preset" })}>
              {preset.label}
            </button>
          ))}
        </div>
        <label className="coordinate-input">
          緯度
          <input
            type="number"
            step="0.000001"
            value={props.origin.lat}
            onChange={(event) =>
              props.onOriginChange({ ...props.origin, lat: Number(event.target.value), source: "manual", label: "緯度経度で指定" })
            }
          />
        </label>
        <label className="coordinate-input">
          経度
          <input
            type="number"
            step="0.000001"
            value={props.origin.lng}
            onChange={(event) =>
              props.onOriginChange({ ...props.origin, lng: Number(event.target.value), source: "manual", label: "緯度経度で指定" })
            }
          />
        </label>
      </section>

      <section className="form-section">
        <div className="section-title">
          <Route size={18} />
          <h2>走れる範囲</h2>
        </div>
        <div className="segmented">
          <button className={props.constraintType === "duration" ? "active" : ""} onClick={() => props.onConstraintTypeChange("duration")}>
            時間
          </button>
          <button className={props.constraintType === "distance" ? "active" : ""} onClick={() => props.onConstraintTypeChange("distance")}>
            距離
          </button>
        </div>
        <label className="range-label">
          <span>
            {props.constraintType === "duration" ? "走行時間" : "走行距離"}: {props.constraintValue}
            {props.constraintType === "duration" ? "分" : "km"}
          </span>
          <input
            type="range"
            min={props.constraintType === "duration" ? 90 : 60}
            max={props.constraintType === "duration" ? 600 : 420}
            step={props.constraintType === "duration" ? 30 : 20}
            value={props.constraintValue}
            onChange={(event) => props.onConstraintValueChange(Number(event.target.value))}
          />
        </label>
        <div className="segmented highway-grid">
          {highwayOptions.map((option) => (
            <button
              key={option.value}
              className={props.highwayMode === option.value ? "active" : ""}
              onClick={() => props.onHighwayModeChange(option.value)}
            >
              <strong>{option.label}</strong>
              <span>{option.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="form-section">
        <div className="section-title">
          <Bot size={18} />
          <h2>生成モード</h2>
        </div>
        <div className="segmented generation-grid">
          {generationOptions.map((option) => (
            <button
              key={option.value}
              className={props.generationMode === option.value ? "active" : ""}
              onClick={() => props.onGenerationModeChange(option.value)}
            >
              <strong>{option.label}</strong>
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
            <button className="small-button" onClick={props.onRefreshCodexStatus}>
              更新
            </button>
            <button className="small-button primary" onClick={props.onStartCodexLogin} disabled={props.isCodexLoginLoading}>
              {props.isCodexLoginLoading ? "開始中" : "ログイン"}
            </button>
          </div>
        </div>
        {props.codexLogin?.type === "chatgptDeviceCode" && (
          <div className="login-card">
            <span>以下のURLでコードを入力</span>
            <a href={props.codexLogin.verificationUrl} target="_blank" rel="noreferrer">
              {props.codexLogin.verificationUrl}
            </a>
            <strong>{props.codexLogin.userCode}</strong>
          </div>
        )}
        {props.codexLogin?.type === "chatgpt" && (
          <div className="login-card">
            <span>ブラウザでChatGPTログイン</span>
            <a href={props.codexLogin.authUrl} target="_blank" rel="noreferrer">
              ログイン画面を開く
            </a>
          </div>
        )}
      </section>

      <section className="form-section">
        <div className="section-title">
          <Bike size={18} />
          <h2>好み</h2>
        </div>
        <PreferenceSegment label="走りやすい道" value={props.preferences.road} labels={["控えめ", "ほどよく", "重視"]} onChange={(road) => props.onPreferencesChange({ ...props.preferences, road })} />
        <PreferenceSegment label="景勝地" value={props.preferences.scenic} labels={["少なめ", "ほどよく", "重視"]} onChange={(scenic) => props.onPreferencesChange({ ...props.preferences, scenic })} />
        <PreferenceSegment label="グルメ" value={props.preferences.gourmet} labels={["軽め", "ほどよく", "重視"]} onChange={(gourmet) => props.onPreferencesChange({ ...props.preferences, gourmet })} />
        <PreferenceSegment label="ゆったり" value={props.preferences.relaxed} labels={["詰める", "標準", "ゆったり"]} onChange={(relaxed) => props.onPreferencesChange({ ...props.preferences, relaxed })} />
        <div className="segmented">
          <button className={props.tripStyle === "half_day" ? "active" : ""} onClick={() => props.onTripStyleChange("half_day")}>
            半日
          </button>
          <button className={props.tripStyle === "day_trip" ? "active" : ""} onClick={() => props.onTripStyleChange("day_trip")}>
            日帰り
          </button>
        </div>
      </section>

      <button className="generate-button" onClick={props.onGenerate} disabled={props.isLoading}>
        <Search size={21} />
        {props.isLoading ? "提案を作成中" : "この条件で提案する"}
      </button>
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

function PlanList(props: {
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
      <p className="mode-pill">
        {props.response.mode === "codex" ? "Codex提案" : "ローカル提案"} / ルートは目安
      </p>
      {props.response.fallbackReason && <p className="fallback-note">{props.response.fallbackReason}</p>}
      {props.response.plans.map((plan, index) => (
        <article key={plan.title} className={`plan-card ${props.selectedIndex === index ? "selected" : ""}`}>
          <button className="plan-main" onClick={() => props.onSelectPlan(plan, index)}>
            <SpotImage stop={plan.stops[0]} />
            <div>
              <h2>{plan.title}</h2>
              <p>{plan.summary}</p>
              <p className="plan-appeal">{plan.appeal}</p>
              <p className="route-story">{plan.routeStory}</p>
              <div className="best-for">
                {plan.bestFor.slice(0, 3).map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <div className="preference-fit">
                {plan.preferenceFit.slice(0, 3).map((fit) => (
                  <span key={fit}>{fit}</span>
                ))}
              </div>
              <span>
                約{plan.estimatedDistanceKm}km / 約{Math.round(plan.estimatedDurationMin / 10) * 10}分 / {plan.highwayUsage} /{" "}
                {plan.routeSource === "osrm" ? "道路ルート" : "簡易目安"}
              </span>
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

function PlanItinerary(props: { plan: Plan | null; selectedSpot: PlanStop | null; onSelectSpot: (spot: PlanStop) => void }) {
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
      {activeSpot && <SpotImage stop={activeSpot} large />}
      <div className="spot-copy">
        <p className="category-label">旅程 / {props.plan.estimatedDistanceKm}km / 約{Math.round(props.plan.estimatedDurationMin / 10) * 10}分</p>
        <h2>{props.plan.title}</h2>
        <p>{props.plan.routeStory}</p>
        <div className="best-for">
          {props.plan.bestFor.slice(0, 3).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
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
                <strong>魅力</strong>
                <p>{activeSpot.famousFor}</p>
              </section>
              <section>
                <strong>ここに寄る理由</strong>
                <p>{activeSpot.whyStopHere}</p>
              </section>
              <section>
                <strong>ライダーメモ</strong>
                <p>{activeSpot.riderNote}</p>
              </section>
              <section>
                <strong>おすすめ</strong>
                <p>{activeSpot.recommendedAction}</p>
              </section>
            </div>
            <div className="preference-fit">
              {activeSpot.matchedPreferences.map((preference) => (
                <span key={preference}>{preferenceLabel(preference)}</span>
              ))}
              <span>滞在目安: {activeSpot.timeHint}</span>
            </div>
            <p className="leg-note">{activeSpot.legNote}</p>
            {activeSpot.images[0] ? (
              <a href={activeSpot.images[0].sourceUrl} target="_blank" rel="noreferrer">
                {activeSpot.images[0].credit} / {activeSpot.images[0].license}
              </a>
            ) : (
              <span className="credit">画像なし: カテゴリ別プレースホルダー</span>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function SpotImage({ stop, large = false }: { stop?: Pick<PlanStop, "name" | "category" | "images">; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const image = stop?.images?.[0];
  useEffect(() => {
    setFailed(false);
  }, [image?.url, stop?.name]);
  if (!image || failed) {
    return (
      <div className={`spot-image placeholder ${large ? "large" : ""} ${stop?.category ?? "road"}`}>
        {categoryIcon(stop?.category ?? "road")}
        <span>{stop ? categoryLabel(stop.category) : "Spot"}</span>
      </div>
    );
  }
  return <img className={`spot-image ${large ? "large" : ""}`} src={image.url} alt={image.alt || stop?.name} onError={() => setFailed(true)} loading="lazy" />;
}

function messageForPlanResponse(response: PlanResponse) {
  if (response.mode === "codex") return "Codexが選んだスポットをサーバーで検証して表示しています。";
  if (response.fallbackReason) return `${response.fallbackReason} ローカル提案を表示しています。`;
  return "収集済みスポットからローカル提案を表示しています。";
}

function statusMessage(status: CodexStatus) {
  if (!status.codexAvailable) return status.message || "Codex app-serverを利用できません。";
  if (status.authMode === "chatgpt") return `Codexログイン済みです${status.planType ? `（${status.planType}）` : ""}。`;
  return "Codexは未ログインです。自動モードではローカル生成に切り替わります。";
}

function codexStatusLabel(status: CodexStatus | null) {
  if (!status) return "Codex状態を確認中";
  if (!status.codexAvailable) return "Codex利用不可";
  if (status.authMode === "chatgpt") return "Codexログイン済み";
  return "Codex未ログイン";
}

function codexStatusDetail(status: CodexStatus | null) {
  if (!status) return "自動モードは確認後に利用します";
  if (!status.codexAvailable) return status.message || "app-serverを起動できません";
  if (status.authMode === "chatgpt") return status.planType ? `ChatGPT ${status.planType}` : "ChatGPT認証";
  return "未ログイン時はローカルJSONで生成します";
}

function sourceLabel(source: string) {
  return source === "gps" ? "GPS" : source === "manual" ? "手動" : "プリセット";
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
      return "#f97316";
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
