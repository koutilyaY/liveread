import { AuthForm } from "../../components/AuthForm";

export const metadata = { title: "Sign in" };

export default function SigninPage() {
  return <AuthForm mode="signin" />;
}
