import { RouterProvider } from 'react-router-dom';
import { router } from './router';

/** 应用根组件：挂载 React Router（路由表见 router.tsx）。 */
export default function App() {
  return <RouterProvider router={router} />;
}
