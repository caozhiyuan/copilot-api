import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export function NotFoundPage(): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Not found</CardTitle>
        <CardDescription>The page you are looking for does not exist.</CardDescription>
      </CardHeader>
    </Card>
  )
}
