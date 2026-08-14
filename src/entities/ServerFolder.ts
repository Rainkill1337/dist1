import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 服务器自定义目录挂载。
 *
 * 仅 root 用户可配置。每条记录代表一个可被「服务器文件」模块访问的
 * 真实文件系统目录。前端通过 `uploads:` 与 `custom:<id>:` 前缀区分根。
 */
@Entity()
export class ServerFolder {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 显示名称（如「影视库」「下载目录」）。 */
  @Column()
  name!: string;

  /** 服务器上真实存在的绝对路径。 */
  @Column()
  absPath!: string;

  /** 是否只读（true 时禁止上传/新建/重命名/删除）。 */
  @Column({ type: 'boolean', default: false })
  readonly!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
