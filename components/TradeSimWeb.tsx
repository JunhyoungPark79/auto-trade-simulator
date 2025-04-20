"use client";

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  LineElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 차트 컴포넌트 등록
ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Title, Tooltip, Legend);

// ===== 전략 파라미터 =====
const RSI_PERIOD = 14;
const SMA_SHORT_PERIOD = 5;
const SMA_LONG_PERIOD = 20;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const RSI_BUY_THRESHOLD = 30;
const VWAP_CONDITION = true;
const TAKE_PROFIT_PCT = 0.7;
const STOP_LOSS_PCT = -0.5;
const CAPITAL_GAIN_TAX_RATE = 0.22;
const BROKER_COMMISSION_RATE = 0.0023;
const MAX_HOLD_TIME = 90;

// ===== WebSocket 커스텀 훅 =====
function useFinnhubWS(
  apiKey: string,
  symbol: string,
  onTrade: (price: number, volume: number) => void
) {
  const [status, setStatus] = useState("🔌 대기 중...");
  const wsRef = useRef<WebSocket | null>(null);
  const retryCount = useRef(0);
  const timeoutRef = useRef<number>();

  useEffect(() => {
    if (!apiKey) return;
    let mounted = true;

    const connect = () => {
      if (!mounted) return;
      setStatus("🔌 연결 시도 중...");
      const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("✅ 연결됨");
        retryCount.current = 0;
        ws.send(JSON.stringify({ type: "subscribe", symbol }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "trade" && data.data.length) {
          const { p: price, v: volume } = data.data[0];
          onTrade(price, volume || 1);
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket 에러", err);
        setStatus("🚨 에러 발생");
        ws.close();
      };

      ws.onclose = () => {
        setStatus("❌ 연결 종료");
        if (!mounted) return;
        const delay = Math.min(30000, 1000 * 2 ** retryCount.current);
        timeoutRef.current = window.setTimeout(() => {
          retryCount.current += 1;
          connect();
        }, delay);
      };
    };

    connect();
    return () => {
      mounted = false;
      wsRef.current?.close();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [apiKey, symbol, onTrade]);

  return status;
}

// ===== 지표 계산 함수 =====
function calculate_rsi(data: number[]) {
  if (data.length < RSI_PERIOD + 1) return null;
  const deltas = data.map((v, i) => (i === 0 ? 0 : v - data[i - 1]));
  const up = deltas.map((d) => (d > 0 ? d : 0));
  const down = deltas.map((d) => (d < 0 ? -d : 0));
  const avgUp = up.slice(-RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  const avgDown = down.slice(-RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  if (avgDown === 0) return 100;
  const rs = avgUp / avgDown;
  return 100 - 100 / (1 + rs);
}

function calculate_sma(data: number[], period: number) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculate_macd(data: number[]) {
  if (data.length < MACD_SLOW) return [null, null];
  const ema = (arr: number[], n: number) => {
    const k = 2 / (n + 1);
    return arr.reduce((acc, cur, i) => {
      if (i === 0) acc.push(cur);
      else acc.push(cur * k + acc[i - 1] * (1 - k));
      return acc;
    }, [] as number[]);
  };
  const fast = ema(data, MACD_FAST);
  const slow = ema(data, MACD_SLOW);
  const macd = fast.map((v, i) => v - slow[i]);
  const signal = ema(macd.slice(MACD_SLOW - 1), MACD_SIGNAL);
  return [macd.at(-1), signal.at(-1)];
}

function calculate_vwap(p: number[], v: number[]) {
  if (p.length < 2 || v.length !== p.length) return null;
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < p.length; i++) {
    cumPV += p[i] * v[i];
    cumV += v[i];
  }
  return cumPV / cumV;
}

function calculate_net_profit(entry: number, exit: number) {
  let gross = (exit - entry) / entry;
  gross -= BROKER_COMMISSION_RATE * 2;
  if (gross > 0) gross *= 1 - CAPITAL_GAIN_TAX_RATE;
  return gross * 100;
}

export default function TradeSimWeb() {
  // ===== 상태 변수 =====
  const [apiKey, setApiKey] = useState("");
  const [symbol, setSymbol] = useState("TQQQ");
  const [prices, setPrices] = useState<number[]>([]);
  const [volumes, setVolumes] = useState<number[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [intervalSec, setIntervalSec] = useState(5);

  // WebSocket 상태 및 가격 수신
  const socketStatus = useFinnhubWS(apiKey, symbol, (price, volume) => {
    setPrices((prev) => [...prev.slice(-99), price]);
    setVolumes((prev) => [...prev.slice(-99), volume]);
  });

  // 시뮬레이션 함수 메모이제이션
  const simulate = useCallback(() => {
    const newLogs: any[] = [];
    let holding = false;
    let entry = 0;
    let entryIdx = 0;

    for (let i = 0; i < prices.length; i++) {
      const p = prices[i];
      const v = volumes[i] || 1;
      const rsi = calculate_rsi(prices.slice(0, i + 1));
      const sma5 = calculate_sma(prices.slice(0, i + 1), SMA_SHORT_PERIOD);
      const sma20 = calculate_sma(prices.slice(0, i + 1), SMA_LONG_PERIOD);
      const vwap = calculate_vwap(prices.slice(0, i + 1), volumes.slice(0, i + 1));
      const [macd, signal] = calculate_macd(prices.slice(0, i + 1));
      const reasons: string[] = [];
      if (rsi && rsi < RSI_BUY_THRESHOLD) reasons.push("RSI<30");
      if (VWAP_CONDITION && vwap && p > vwap) reasons.push("VWAP 돌파");
      if (sma5 && sma20 && sma5 > sma20) reasons.push("골든크로스");
      if (macd && signal && macd > signal) reasons.push("MACD 상향 돌파");
      if (!holding && reasons.length === 4) {
        holding = true;
        entry = p;
        entryIdx = i;
        newLogs.push({ time: i, type: "BUY", price: p, reason: reasons.join(", ") });
      } else if (holding) {
        const net = calculate_net_profit(entry, p);
        if (net >= TAKE_PROFIT_PCT || net <= STOP_LOSS_PCT || i - entryIdx >= MAX_HOLD_TIME) {
          holding = false;
          newLogs.push({ time: i, type: "SELL", price: p, profit: net });
        }
      }
    }
    setLogs(newLogs);
  }, [prices, volumes]);

  // 자동 시뮬레이션 실행
  useEffect(() => {
    if (!apiKey || prices.length < 20 || intervalSec < 1) return;
    const id = setInterval(simulate, Math.max(1000, intervalSec * 1000));
    return () => clearInterval(id);
  }, [apiKey, prices, intervalSec, simulate]);

  // 누적 수익률 메모이제이션
  const cumulative = useMemo(() => logs.filter((d) => d.type === "SELL").reduce((acc, cur, i) => {
    acc.push((acc[i - 1] || 0) + (cur.profit || 0));
    return acc;
  }, [] as number[]), [logs]);

  // ===== 렌더링 =====
  return (
    <div className="p-4 space-y-6 max-w-3xl mx-auto">
      {/* 설정 입력 */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <Label>🔐 API Key (finnhub.io)</Label>
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="d0xxxxyyyzzz" />
          <Label>📈 종목 심볼</Label>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
          <Label>⏱️ 시뮬레이션 주기 (초)</Label>
          <Input type="number" min={1} value={intervalSec} onChange={(e) => setIntervalSec(Math.max(1, parseInt(e.target.value, 10)))} />
        </CardContent>
      </Card>

      {/* 상태 및 가격 */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <p>📶 WS 상태: {socketStatus}</p>
          <p>💲 실시간 가격: {prices.at(-1)?.toFixed(2) ?? "-"}</p>
        </CardContent>
      </Card>

      {/* 누적 수익률 차트 */}
      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="text-lg font-semibold">📈 누적 수익률</h2>
          <Line data={{ labels: cumulative.map((_, i) => i + 1), datasets: [{ label: "% 누적 수익률", data: cumulative, fill: true }] }} />
        </CardContent>
      </Card>

      {/* 매매 로그 테이블 */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <h2 className="text-lg font-semibold">🧾 매매 로그</h2>
          <div className="overflow-auto max-h-64">
            <table className="w-full text-sm text-left">
              <thead><tr className="border-b"><th>시간</th><th>타입</th><th>가격</th><th>수익률</th><th>비고</th></tr></thead>
              <tbody>
                {logs.map((log, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="py-1 pr-4">{log.time}</td>
                    <td className="py-1 pr-4">{log.type}</td>
                    <td className="py-1 pr-4">{log.price.toFixed(2)}</td>
                    <td className="py-1 pr-4">{log.profit?.toFixed(2)}%</td>
                    <td className="py-1 pr-4">{log.reason || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
