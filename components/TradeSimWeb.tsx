"use client";

import React, { useEffect, useRef, useState } from "react";
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
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/label";

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Title, Tooltip, Legend);

// 전략 파라미터
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

export default function TradeSimWeb() {
  const [apiKey, setApiKey] = useState("");
  const [symbol, setSymbol] = useState("TQQQ");
  const [prices, setPrices] = useState<number[]>([]);
  const [volumes, setVolumes] = useState<number[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (apiKey.trim() === "") return;

    const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);
    socketRef.current = ws;

    ws.onopen = () => {
      console.log("✅ WebSocket 연결됨");
      ws.send(JSON.stringify({ type: "subscribe", symbol }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "trade") {
        const price = data.data[0]?.p;
        const volume = data.data[0]?.v || 1;
        if (price) {
          setPrices((prev) => [...prev.slice(-99), price]);
          setVolumes((prev) => [...prev.slice(-99), volume]);
        }
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket 에러", err);
    };

    return () => {
      ws.close();
    };
  }, [apiKey, symbol]);

  const calculate_rsi = (data: number[]) => {
    if (data.length < RSI_PERIOD + 1) return null;
    const deltas = data.map((v, i) => i === 0 ? 0 : v - data[i - 1]);
    let up = deltas.map(d => d > 0 ? d : 0);
    let down = deltas.map(d => d < 0 ? -d : 0);
    let avgUp = up.slice(-RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
    let avgDown = down.slice(-RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
    if (avgDown === 0) return 100;
    let rs = avgUp / avgDown;
    return 100 - 100 / (1 + rs);
  };

  const calculate_sma = (data: number[], period: number) => {
    if (data.length < period) return null;
    return data.slice(-period).reduce((a, b) => a + b, 0) / period;
  };

  const calculate_macd = (data: number[]) => {
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
  };

  const calculate_vwap = (p: number[], v: number[]) => {
    if (p.length < 2 || v.length !== p.length) return null;
    let cumPV = 0, cumV = 0;
    for (let i = 0; i < p.length; i++) {
      cumPV += p[i] * v[i];
      cumV += v[i];
    }
    return cumPV / cumV;
  };

  const calculate_net_profit = (entry: number, exit: number) => {
    let gross = (exit - entry) / entry;
    gross -= BROKER_COMMISSION_RATE * 2;
    if (gross > 0) gross *= 1 - CAPITAL_GAIN_TAX_RATE;
    return gross * 100;
  };

  const simulate = () => {
    const newLogs: any[] = [];
    let holding = false, entry = 0, entryIdx = 0;
    for (let i = 0; i < prices.length; i++) {
      const p = prices[i];
      const v = volumes[i] || 1;
      const rsi = calculate_rsi(prices.slice(0, i + 1));
      const sma5 = calculate_sma(prices.slice(0, i + 1), SMA_SHORT_PERIOD);
      const sma20 = calculate_sma(prices.slice(0, i + 1), SMA_LONG_PERIOD);
      const vwap = calculate_vwap(prices.slice(0, i + 1), volumes.slice(0, i + 1));
      const [macd, signal] = calculate_macd(prices.slice(0, i + 1));
      const reasons = [];
      if (rsi && rsi < RSI_BUY_THRESHOLD) reasons.push("RSI<30");
      if (VWAP_CONDITION && vwap && p > vwap) reasons.push("VWAP 돌파");
      if (sma5 && sma20 && sma5 > sma20) reasons.push("골든크로스");
      if (macd && signal && macd > signal) reasons.push("MACD 상향 돌파");

      if (!holding && reasons.length === 4) {
        entry = p;
        entryIdx = i;
        holding = true;
        newLogs.push({ time: i, type: "BUY", price: p, reason: reasons.join(", ") });
      } else if (holding) {
        const net = calculate_net_profit(entry, p);
        if (net >= TAKE_PROFIT_PCT || net <= STOP_LOSS_PCT || i - entryIdx >= MAX_HOLD_TIME) {
          newLogs.push({ time: i, type: "SELL", price: p, profit: net });
          holding = false;
        }
      }
    }
    setLogs(newLogs);
  };

  const cumulative = logs.filter(d => d.type === "SELL").reduce((acc, cur, i) => {
    acc.push((acc[i - 1] || 0) + (cur.profit || 0));
    return acc;
  }, []);

  return (
    <div className="p-4 space-y-6 max-w-3xl mx-auto">
      <Card>
        <CardContent className="space-y-2 p-4">
          <Label>🔐 API Key (finnhub.io)</Label>
          <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="d0xxxxyyyzzz" />
          <Label>📈 관심 종목 (예: TQQQ, TSLA)</Label>
          <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <Button onClick={simulate}>📊 시뮬레이션 실행</Button>
          <p>실시간 가격 수신 중: {prices.at(-1)?.toFixed(2)}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4">
          <h2 className="text-lg font-semibold">📈 누적 수익률</h2>
          <Line data={{
            labels: logs.filter(d => d.type === "SELL").map((_, i) => i + 1),
            datasets: [
              {
                label: "누적 수익률 (%)",
                data: cumulative,
                borderColor: "rgb(75, 192, 192)",
                backgroundColor: "rgba(75, 192, 192, 0.2)",
                borderWidth: 2,
                fill: true,
              },
            ],
          }} />
        </CardContent>
      </Card>
<Card>
  <CardContent className="space-y-2 p-4">
    <h2 className="text-lg font-semibold">🧾 매매 로그</h2>
    <div className="overflow-auto">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="border-b">
            <th className="py-1 pr-4">시간</th>
            <th className="py-1 pr-4">타입</th>
            <th className="py-1 pr-4">가격</th>
            <th className="py-1 pr-4">수익률</th>
            <th className="py-1 pr-4">비고</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log, i) => (
            <tr key={i} className="border-b">
              <td className="py-1 pr-4">{log.time}</td>
              <td className="py-1 pr-4">{log.type}</td>
              <td className="py-1 pr-4">{log.price.toFixed(2)}</td>
              <td className="py-1 pr-4">
                {log.profit !== undefined ? `${log.profit.toFixed(2)}%` : "-"}
              </td>
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