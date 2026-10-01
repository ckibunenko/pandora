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
import { RequireAdmin } from "../features/admin/AdminShared";
import { OrganizationPage } from "../features/admin/OrganizationPage";
import { OrganizationsPage } from "../features/admin/OrganizationsPage";
import { UserPage } from "../features/admin/UserPage";
import { UsersPage } from "../features/admin/UsersPage";
import { OrderPage } from "../features/orders/OrderPage";
import { OrdersPage } from "../features/orders/OrdersPage";
import { AuditPage } from "../features/audit/AuditPage";
import { AuditEventPage } from "../features/audit/AuditEventPage";
import { NotificationPage } from "../features/notifications/NotificationPage";
import { NotificationsPage } from "../features/notifications/NotificationsPage";

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
                element: <RequireAdmin />,
                children: [
                  { path: "/admin/organizations", element: <OrganizationsPage /> },
                  { path: "/admin/organizations/new", element: <OrganizationPage create /> },
                  { path: "/admin/organizations/:organizationId", element: <OrganizationPage /> },
                  { path: "/admin/users", element: <UsersPage /> },
                  { path: "/admin/users/new", element: <UserPage create /> },
                  { path: "/admin/users/:userId", element: <UserPage /> },
                ],
              },
              { path: "/orders", element: <OrdersPage /> },
              { path: "/orders/:orderId", element: <OrderPage /> },
              {
                element: <RequireStaff />,
                children: [
                  { path: "/inventory", element: <InventoryPage /> },
                  { path: "/inventory/:variantId", element: <InventoryItemPage /> },
                ],
              },
              {
                element: <RequireStaff area="The audit trail" />,
                children: [
                  { path: "/audit", element: <AuditPage /> },
                  { path: "/audit/:eventId", element: <AuditEventPage /> },
                ],
              },
              {
                element: <RequireStaff area="Notification diagnostics" />,
                children: [
                  { path: "/notifications", element: <NotificationsPage /> },
                  { path: "/notifications/:notificationId", element: <NotificationPage /> },
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
