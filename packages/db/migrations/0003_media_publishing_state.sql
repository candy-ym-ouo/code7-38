-- 媒体发布认领状态：审核员确认隐私时，媒体先从 manual_review 原子推进到
-- publishing，公开派生对象复制并定稿后才变为 ready；失败或卡住时补偿回滚
-- 到 manual_review 并删除已复制的公开对象。该中间态让并发确认只有一方能
-- 认领成功，并让恢复任务能识别“已复制但未定稿”的公开对象。
-- 注意：ALTER TYPE ... ADD VALUE 需要 PostgreSQL 12+ 才能在事务中执行。
ALTER TYPE media_status ADD VALUE IF NOT EXISTS 'publishing';
