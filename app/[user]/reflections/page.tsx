import { ReflectionsPage } from "@/app/components/ReflectionsView";

export default function Page({ params }: { params: { user: string } }) {
  return <ReflectionsPage userId={params.user} />;
}
