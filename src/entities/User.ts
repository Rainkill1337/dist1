import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type UserRole = 'root' | 'admin' | 'user' | 'guest';
export type UserStatus = 'active' | 'pending';

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  username!: string;

  @Column()
  passwordHash!: string;

  @Column({ type: 'simple-enum', enum: ['root', 'admin', 'user', 'guest'], default: 'guest' })
  role!: UserRole;

  @Column({ type: 'simple-enum', enum: ['active', 'pending'], default: 'pending' })
  status!: UserStatus;

  /**
   * 头像 URL（相对路径，如 '/uploads/avatars/1-1716840000000.jpg'）。
   * 为 null 时前端使用默认头像（root 用 /root-avatar.jpg，其他用 User 图标）。
   */
  @Column({ type: 'varchar', nullable: true })
  avatar!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
