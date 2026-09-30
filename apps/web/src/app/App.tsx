import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { RequireAuth } from "../features/auth/RequireAuth";
import { HomePage } from "../routes/HomePage";
import { LoginPage } from "../routes/LoginPage";
import { AppShell } from "./AppShell";

import {
  CatalogLayout,
  RequireCatalogAdmin,
} from "../features/catalog/CatalogLayout";
import { CatalogPage } from "../features/catalog/CatalogPage";
import { ProductPage } from "../features/catalog/ProductPage";
import { AdminProductPage } from "../features/catalog/AdminProductPage";
import { InventoryItemPage, RequireStaff } from "../features/inventory/InventoryItemPage";
import { InventoryPage } from "../features/inventory/InventoryPage";

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/login", element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: "/", element: <HomePage /> },
          {
            element: <CatalogLayout />,
            children: [
              { path: "/catalog", element: <CatalogPage /> },
              { path: "/catalog/:productId", element: <ProductPage /> },
              {
                element: <RequireCatalogAdmin />,
                children: [
                  { path: "/admin/catalog", element: <CatalogPage admin /> },
                  {
                    path: "/admin/catalog/new",
                    element: <AdminProductPage create />,
                  },
                  {
                    path: "/admin/catalog/:productId",
                    element: <AdminProductPage />,
                  },
                ],
              },
              {
                element: <RequireStaff />,
                children: [
                  { path: "/inventory", element: <InventoryPage /> },
                  { path: "/inventory/:variantId", element: <InventoryItemPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
