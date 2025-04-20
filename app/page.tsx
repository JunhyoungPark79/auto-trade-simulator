// app/page.tsx

import TradeSimWeb from "@/components/TradeSimWeb"; // 우리가 만든 자동매매 시뮬레이터 컴포넌트 가져오기

export default function Page() {
  return (
    <main className="p-6">
      <TradeSimWeb />
    </main>
  );
}
