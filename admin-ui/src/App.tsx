import { Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { AccountsPage } from "@/pages/accounts-page"
import { NotFoundPage } from "@/pages/not-found-page"
import { RequestDetailPage } from "@/pages/request-detail-page"
import { RequestsPage } from "@/pages/requests-page"

export default function App(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/accounts" replace />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/request/:requestId" element={<RequestDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
