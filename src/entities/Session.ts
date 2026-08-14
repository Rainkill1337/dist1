import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Room } from './Room';

export type SessionRole = 'sharer' | 'viewer';

@Entity()
export class Session {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  roomId!: string;

  @Column()
  socketId!: string;

  @Column({ type: 'simple-enum', enum: ['sharer', 'viewer'] })
  role!: SessionRole;

  /**
   * 关联的用户 ID（guest 用户为 null）。
   * 用于检测同一账户是否已在房间内（防止多标签页同时进入同一房间）。
   */
  @Column({ type: 'int', nullable: true })
  userId!: number | null;

  @CreateDateColumn()
  startedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  endedAt!: Date | null;

  @ManyToOne(() => Room, (room) => room.sessions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'roomId', referencedColumnName: 'roomId' })
  room!: Room;
}
