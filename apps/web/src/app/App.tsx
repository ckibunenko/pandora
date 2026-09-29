import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { HomePage } from "../routes/HomePage";

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
  },
});

const router = createBrowserRouter([{ path: "/", element: <HomePage /> }]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
