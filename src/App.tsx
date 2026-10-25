import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LandingPage } from './pages/LandingPage';
import { ChatPage } from './pages/ChatPage';
import { ExpiredPage } from './pages/ExpiredPage';
import { StoryPage } from './pages/StoryPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminConversations } from './pages/admin/AdminConversations';
import { AdminConversationDetail } from './pages/admin/AdminConversationDetail';
import { AdminCreateLink } from './pages/admin/AdminCreateLink';
import { AdminStats } from './pages/admin/AdminStats';
import { AdminClients } from './pages/admin/AdminClients';
import { AdminClientDetail } from './pages/admin/AdminClientDetail';
import { AdminCoachMoves } from './pages/admin/AdminCoachMoves';
import { PlanEditorPage } from './pages/plan/PlanEditorPage';
import { PlanPage } from './pages/plan/PlanPage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/c/:id" element={<ChatPage />} />
        {/* 交付方案页：用户打开自己的链接就能看到今天该练哪张卡、在这里打卡。
            「链接即凭证」与 /c/:id 同一套信任模型。 */}
        <Route path="/c/:id/plan" element={<PlanPage />} />
        <Route path="/story/:id" element={<StoryPage />} />
        <Route path="/expired" element={<ExpiredPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminConversations />} />
          <Route path="conversations/:id" element={<AdminConversationDetail />} />
          <Route path="clients" element={<AdminClients />} />
          <Route path="clients/:id" element={<AdminClientDetail />} />
          <Route path="plans/:planId" element={<PlanEditorPage />} />
          <Route path="coach-moves" element={<AdminCoachMoves />} />
          <Route path="create-link" element={<AdminCreateLink />} />
          <Route path="stats" element={<AdminStats />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
