/**
 * pkg 打包工具的类型声明。
 *
 * 当使用 @yao-pkg/pkg 打包后，运行时会在 process 对象上设置
 * process.pkg 属性，用于标识代码运行在 pkg 虚拟文件系统中。
 */
declare namespace NodeJS {
  interface Process {
    pkg?: boolean;
  }
}