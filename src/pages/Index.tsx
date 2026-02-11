import { useState } from 'react';
import { DashboardProvider } from '@/context/DashboardContext';
import DashboardHeader from '@/components/dashboard/DashboardHeader';
import AddAddressTab from '@/components/dashboard/AddAddressTab';
import TrackingTab, { type PaperTradePrefill } from '@/components/dashboard/TrackingTab';
import PaperTradeTab from '@/components/dashboard/PaperTradeTab';
import RealTradeTab from '@/components/dashboard/RealTradeTab';

const Index = () => {
  const [activeTab, setActiveTab] = useState(0);
  const [paperTradeId, setPaperTradeId] = useState<string | null>(null);
  const [paperTradePrefill, setPaperTradePrefill] = useState<PaperTradePrefill | null>(null);

  const handlePaperTrade = (addressId: string, prefill?: PaperTradePrefill) => {
    setPaperTradeId(addressId);
    setPaperTradePrefill(prefill || null);
    setActiveTab(2);
  };

  return (
    <DashboardProvider>
      <div className="min-h-screen bg-background">
        <DashboardHeader activeTab={activeTab} onTabChange={(tab) => {
          setActiveTab(tab);
          if (tab !== 2) {
            setPaperTradeId(null);
            setPaperTradePrefill(null);
          }
        }} />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          {activeTab === 0 && <AddAddressTab />}
          {activeTab === 1 && <TrackingTab onPaperTrade={handlePaperTrade} />}
          {activeTab === 2 && <PaperTradeTab preselectedId={paperTradeId} prefill={paperTradePrefill} />}
          {activeTab === 3 && <RealTradeTab />}
        </main>
      </div>
    </DashboardProvider>
  );
};

export default Index;
