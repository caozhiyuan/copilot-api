import { useTranslation } from "react-i18next"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function NotFoundPage(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("notFound.title")}</CardTitle>
        <CardDescription>{t("notFound.description")}</CardDescription>
      </CardHeader>
    </Card>
  )
}
