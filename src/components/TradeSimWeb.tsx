import React, { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Title, Tooltip, Legend);

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

export default function TradeSimWeb() {
  const [prices, setPrices] = useState<number[]>([]);
  const [volumes, setVolumes] = useState<number[]>([]);
  const [logs, setLogs] = useState<any[]>([]);

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
          <Label>가격 시퀀스 (쉼표 구분)</Label>
          <Input value={prices.join(",")} onChange={e => setPrices(e.target.value.split(",").map(Number))} />
          <Label>거래량 시퀀스 (선택)</Label>
          <Input value={volumes.join(",")} onChange={e => setVolumes(e.target.value.split(",").map(Number))} />
          <Button onClick={simulate}>매매 전략 실행</Button>
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
    </div>
  );
}
