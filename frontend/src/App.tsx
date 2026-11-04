import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Home } from "./pages/Home";
import { Deposit } from "./pages/Deposit";
import { Withdraw } from "./pages/Withdraw";
import { Automate } from "./pages/Automate";
import { Activity } from "./pages/Activity";
import { Tools } from "./pages/Tools";
import { Pay } from "./pages/Pay";
import { Bridge } from "./pages/Bridge";

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/deposit" element={<Deposit />} />
        <Route path="/bridge" element={<Bridge />} />
        <Route path="/withdraw" element={<Withdraw />} />
        <Route path="/automate" element={<Automate />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/tools" element={<Tools />} />
        <Route path="/pay/:id" element={<Pay />} />
        <Route path="/pay-per-use" element={<Navigate to="/tools" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
