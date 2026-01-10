import { Redirect } from "expo-router";

export default function Index() {
  // This triggers the routing logic in your app/_layout.js
  return <Redirect href="/(auth)/auth" />;
}