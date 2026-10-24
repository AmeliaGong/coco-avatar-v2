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

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/chat" element={<Navigate to="/" replace />} />
        <Route path="/c/:id" element={<ChatPage />} />
        <Route path="/story/:id" element={<StoryPage />} />
        <Route path="/expired" element={<ExpiredPage />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminConversations />} />
          <Route path="conversations/:id" element={<AdminConversationDetail />} />
          <Route path="create-link" element={<AdminCreateLink />} />
          <Route path="stats" element={<AdminStats />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
