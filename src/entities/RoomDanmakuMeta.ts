import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 房间弹幕辅助数据持久化实体。
 *
 * 每个房间一条记录，存储：
 * - 屏蔽关键词列表（房主设置，全房间共享）
 * - 已删除弹幕记录（用于管理面板展示与恢复）
 * - 实时弹幕记录（房间内用户互发的弹幕事件，含视频进度）
 *
 * 三个字段均为 JSON 序列化的数组，整体读写，适合低频写入场景。
 */
@Entity()
export class RoomDanmakuMeta {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 所属房间 ID（唯一，每房间一条记录） */
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  roomId!: string;

  /** 屏蔽关键词数组，JSON 序列化存储 */
  @Column({ type: 'text', default: '[]' })
  blockKeywords!: string;

  /** 已删除弹幕记录数组，JSON 序列化存储 */
  @Column({ type: 'text', default: '[]' })
  deletedLog!: string;

  /** 实时弹幕记录数组，JSON 序列化存储 */
  @Column({ type: 'text', default: '[]' })
  realtimeLog!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
