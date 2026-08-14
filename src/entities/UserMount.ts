import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type MountType = 'webdav' | 'ftp' | 'openlist' | 'emby' | 'jellyfin';

@Entity()
export class UserMount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  userId!: number;

  @Column({ type: 'simple-enum', enum: ['webdav', 'ftp', 'openlist', 'emby', 'jellyfin'] })
  type!: MountType;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  serverUrl!: string | null;

  @Column({ type: 'integer', nullable: true })
  port!: number | null;

  @Column({ type: 'varchar', nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'varchar', nullable: true })
  indexUrl!: string | null;

  /** Emby API Key（X-Emby-Token）；与 username/password 二选一 */
  @Column({ type: 'varchar', nullable: true })
  apiKey!: string | null;

  /** Emby 登录后缓存的用户 ID（运行时使用，可空） */
  @Column({ type: 'varchar', nullable: true })
  embyUserId!: string | null;

  @Column({ type: 'boolean', default: false })
  directLink!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
