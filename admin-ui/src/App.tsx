import { Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { AccountsPage } from "@/pages/accounts-page"
import { ModelsPage } from "@/pages/models-page"
import { NotFoundPage } from "@/pages/not-found-page"
import { RequestDetailPage } from "@/pages/request-detail-page"
import { RequestsPage } from "@/pages/requests-page"
import { SettingsPage } from "@/pages/settings-page"

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/accounts" replace />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/request/:requestId" element={<RequestDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
