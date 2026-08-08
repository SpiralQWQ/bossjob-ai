import { createHashRouter, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, Typography } from 'antd';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import { JobsPage, TrackerPage } from './pages/DataViews';
import ApplyPage from './pages/ApplyPage';
import ResumePage from './pages/ResumePage';
import InterviewPage from './pages/InterviewPage';

const { Sider, Header, Content } = Layout;

/**
 * 应用路由表 + 全局导航外壳。
 *
 * 使用 HashRouter（而非 BrowserRouter）：
 * 生产环境 Electron 以 loadFile 加载 dist/index.html（file:// 协议），
 * BrowserRouter 会把文件系统绝对路径误判为路由路径，导致初始路径匹配失败出现空白页；
 * hash 模式不受协议/路径影响，跨开发（http）与打包（file://）环境均稳定。
 *
 * 导航：Antd Layout 的 Sider/Menu 列出全部模块（key 即路由 path），全部已实现直连页面。
 * 简历 / 投递记录 / 投递 / 面试 当前为「手动记录管理」：仅提供人工填表 / 登记 / 维护，
 * 「投递记录（全部）」= 全部投递记录（/jobs），「投递（手动登记）」= 待投递队列（/apply），
 * 「面试」= 面试中记录视图 + 登记入口（/interview）；
 * 简历解析、岗位库抓取、自动投递等 AI 自动化能力均在规划中，入口文案明确标注「手动」，不暗示已实现 AI 功能。
 */

/** 菜单与路由对应关系（key 即路由 path，label 即侧边栏文案，title 为悬停提示）。 */
const MENU_ITEMS = [
  { key: '/', label: '工作台' },
  { key: '/resume', label: '简历（手动记录）' },
  { key: '/jobs', label: '投递记录（全部）' },
  { key: '/apply', label: '投递（手动登记）' },
  { key: '/interview', label: '面试', title: '面试登记：登记/查看「面试中」记录（时间/形式/备注）' },
  { key: '/tracker', label: '看板' },
  { key: '/settings', label: '设置' },
];

/** 全局导航外壳：侧边栏菜单 + 内容区 Outlet。 */
function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  // 高亮当前路由对应菜单项；未命中（如未知路径）时回退高亮工作台
  const selectedKey = MENU_ITEMS.some((i) => i.key === location.pathname) ? location.pathname : '/';
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" width={200}>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          onClick={({ key }) => navigate(key)}
          items={MENU_ITEMS}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0, lineHeight: '64px' }}>
            求职投递助手
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            当前为手动记录管理，简历解析 / 岗位库抓取 / 自动投递等 AI 自动化功能规划中
          </Typography.Text>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}

export const router = createHashRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'resume', element: <ResumePage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'apply', element: <ApplyPage /> },
      { path: 'interview', element: <InterviewPage /> },
      { path: 'tracker', element: <TrackerPage /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);
