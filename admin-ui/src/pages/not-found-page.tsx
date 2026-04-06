import { useTranslation } from "react-i18next"
import { motion } from "motion/react"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function NotFoundPage(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t("notFound.title")}</CardTitle>
          <CardDescription>{t("notFound.description")}</CardDescription>
        </CardHeader>
      </Card>
    </motion.div>
  )
}
