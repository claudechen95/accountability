import { NotesPage } from "@/app/components/NotesView";

export default function Page({ params }: { params: { user: string } }) {
  return <NotesPage userId={params.user} />;
}
