import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Empty, Input, List, Modal, Space, Spin, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { getBaseUrl } from '../lib/baseUrl';
import { STATUS_COLOR, STATUS_TEXT } from '../lib/applyStatus';
import type { ApplicationItem } from '../types/application';

/**
 * 全局搜索（Cmd+K）：快捷键 Ctrl/Cmd+K 打开搜索框，实时搜投递记录（后端 /api/applications?keyword=，
 * 后端零改动），点击条目跳转记录页并预筛关键词。全程防呆：空关键词不搜、防抖、seq 防过期响应。
 */
export default function GlobalSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<ApplicationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  // useLayoutEffect 同步刷新 openRef：快捷键 handler 总能读到最新 open，避免被动 effect 时序问题
  const openRef = useRef(false);
  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  // 全局快捷键 Ctrl/Cmd+K：开/关切换；打开时清空上次关键词
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (openRef.current) {
          setOpen(false);
        } else {
          setKeyword('');
          setItems([]);
          setSearched(false);
          setOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 防抖搜索（250ms）：空关键词不搜；seq 防过期响应覆盖
  useEffect(() => {
    if (!open) return;
    const q = keyword.trim();
    if (!q) {
      setItems([]);
      setSearched(false);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const baseUrl = await getBaseUrl();
        const res = await fetch(
          `${baseUrl}/api/applications?keyword=${encodeURIComponent(q)}&page_size=10`
        );
        if (!res.ok) throw new Error(`搜索接口返回 HTTP ${res.status}`);
        const data = (await res.json()) as { items: ApplicationItem[] };
        if (seq !== seqRef.current) return; // 过期响应丢弃
        setItems(data.items ?? []);
        setSearched(true);
      } catch {
        if (seq === seqRef.current) {
          setItems([]);
          setSearched(true);
        }
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [keyword, open]);

  const jumpToKeyword = () => {
    const q = keyword.trim();
    if (!q) return;
    navigate(`/jobs?keyword=${encodeURIComponent(q)}`);
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      title="全局搜索"
      width={560}
      destroyOnClose
    >
      <Input
        autoFocus
        prefix={<SearchOutlined />}
        placeholder="搜公司 / 职位，回车跳转记录页"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onPressEnter={jumpToKeyword}
        allowClear
      />
      <div style={{ marginTop: 12 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : searched && items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`无「${keyword.trim()}」相关投递记录`} />
        ) : (
          <List
            size="small"
            dataSource={items}
            renderItem={(item) => (
              <List.Item
                onClick={() => navigate(`/jobs?keyword=${encodeURIComponent(item.job_title)}`)}
                style={{ cursor: 'pointer' }}
                title="跳转记录页并按职位筛选"
              >
                <List.Item.Meta
                  title={
                    <Typography.Text>
                      {item.company} · {item.job_title}
                    </Typography.Text>
                  }
                  description={
                    <Space size="small">
                      <Badge
                        color={STATUS_COLOR[item.status] ?? STATUS_COLOR.closed}
                        text={STATUS_TEXT[item.status] ?? item.status}
                      />
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {item.city}
                      </Typography.Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </Modal>
  );
}
