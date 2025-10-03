import { spawn } from "child_process";
import account from "./account.js"; 
import logger from "#utils/logger.js";
import schedule from "node-schedule";
import AuthService from "./src/services/authService.js";
import fs from "fs";
import path from "path";

// --- 核心修改：根据用户名创建唯一的状态文件路径 ---
// 这样即时运行多个实例，它们也会使用不同的状态文件，互不干扰。
const statusFilePath = path.join(process.cwd(), `restart_status_${account.username || 'default'}.json`);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 记录重启状态到文件
function saveRestartStatus(status) {
  try {
    fs.writeFileSync(statusFilePath, JSON.stringify(status));
  } catch (err) {
    logger.error(`[守护] 保存重启状态失败 (${statusFilePath})`, err);
  }
}

// 读取重启状态
function loadRestartStatus() {
  try {
    if (fs.existsSync(statusFilePath)) {
      return JSON.parse(fs.readFileSync(statusFilePath, "utf8"));
    }
  } catch (err) {
    logger.error(`[守护] 读取重启状态失败 (${statusFilePath})`, err);
  }
  return null;
}

/**
 * @description 通过 AuthService 从外部源获取服务器列表。
 */
async function fetchServerListFromExternalSource(username, password) {
    logger.info("[守护] 正在通过 AuthService 获取服务器列表...");
    try {
        const authServiceInstance = new AuthService();
        const listData = await authServiceInstance.List(username, password);

        if (!listData || !listData.servers || listData.servers.length === 0) {
            logger.error("[守护] AuthService 未返回有效的服务器列表或列表为空。");
            return [];
        }
        const formattedServers = listData.servers.map(server => ({
            id: server.serverId, 
            name: `${server.serverName} (区域ID: ${server.serverId})`
        }));
        return formattedServers;
    } catch (error) {
        logger.error("[守护] 通过 AuthService 获取服务器列表失败:", error.message);
        logger.error("[守护] 捕获到的完整错误对象如下:", error);
        return []; 
    }
}

/**
 * @description 交互式地让用户从列表中选择一个服务器。
 */
async function selectServerInteractive(servers) {
    if (!servers || servers.length === 0) {
        logger.error("[守护] 没有可用的服务器列表供选择。");
        return null;
    }
    console.log("\n请选择一个服务器:");
    servers.forEach((server, index) => {
        console.log(`${index + 1}. ${server.name}`);
    });

    let readlineSync;
    try {
        readlineSync = (await import('readline-sync')).default;
    } catch (e) {
        logger.error("[守护] 无法加载 'readline-sync' 模块。请确保已安装 (npm install readline-sync)。无法进行服务器选择。");
        return null;
    }

    let choiceIndex;
    while (true) {
        const answer = readlineSync.question(`请输入选择的服务器编号 (1-${servers.length}): `); 
        choiceIndex = parseInt(answer, 10) - 1;
        if (choiceIndex >= 0 && choiceIndex < servers.length) {
            break;
        }
        console.log("无效的选择，请重新输入。");
    }
    return servers[choiceIndex].id;
}

const accountFilePath = path.join(process.cwd(), "account.js");

/**
 * @description 更新 account.js 文件。
 */
async function updateAccountFile(newServerId, newUsername, newPassword, shouldUpdateCredentials) {
    try {
        let content = fs.readFileSync(accountFilePath, "utf8");

        const serverIdRegex = /(\s*serverId\s*:\s*)(['"]?)(.*?)(\2)?(\s*,?)/;
        content = content.replace(serverIdRegex, `$1"${newServerId}"$5`);

        if (shouldUpdateCredentials) {
            const usernameRegex = /(\s*username\s*:\s*)(['"]?)(.*?)(\2)?(\s*,?)/;
            content = content.replace(usernameRegex, `$1"${newUsername}"$5`);

            const passwordRegex = /(\s*password\s*:\s*)(['"]?)(.*?)(\2)?(\s*,?)/;
            content = content.replace(passwordRegex, `$1"${newPassword}"$5`);
        }

        fs.writeFileSync(accountFilePath, content, "utf8");
        logger.info(`[守护] account.js 已成功更新。`);
        return true;
    } catch (err) {
        logger.error(`[守护] 更新 account.js 失败:`, err);
        return false;
    }
}

(async () => {
  process.on('uncaughtException', (err) => {
    logger.error("[守护] 守护进程发生未捕获的异常", err);
    saveRestartStatus({ needRestart: true, timestamp: Date.now(), errorType: 'uncaughtException' });
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error("[守护] 守护进程发生未处理的Promise拒绝", reason);
    saveRestartStatus({ needRestart: true, timestamp: Date.now(), errorType: 'unhandledRejection' });
  });

  // --- 用户名、密码和服务器选择逻辑 ---
  logger.info("[守护] 开始检查账户配置...");

  let currentUsername = account.username;
  let currentPassword = account.password;
  let currentServerId = account.serverId;
  let credentialsEnteredByUser = false;

  if (!currentUsername || !currentPassword) {
      logger.info("[守护] account.js 中的用户名或密码为空，请在命令行中输入。");
      let readlineSync;
      try {
          readlineSync = (await import('readline-sync')).default;
      } catch (e) {
          logger.error("[守护] 无法加载 'readline-sync' 模块。请确保已安装 (npm install readline-sync)。无法继续。");
          process.exit(1);
      }

      currentUsername = readlineSync.question("请输入用户名: ");
      currentPassword = readlineSync.question("请输入密码: ", { hideEchoBack: true });
      credentialsEnteredByUser = true;
      logger.info("[守护] 用户名和密码已通过命令行获取。");
  }

  if (!currentServerId) {
      logger.info("[守护] account.js 中未配置 serverId，开始服务器选择流程。");
      const serverList = await fetchServerListFromExternalSource(currentUsername, currentPassword);

      if (serverList && serverList.length > 0) {
          const selectedServerId = await selectServerInteractive(serverList);
          if (selectedServerId) {
              const success = await updateAccountFile(selectedServerId, currentUsername, currentPassword, credentialsEnteredByUser);
              if (!success) {
                  logger.error("[守护] 无法更新 account.js。守护进程将退出。");
                  process.exit(1);
              }
              logger.warn("[守护] 配置已更新，子进程将使用新配置启动。");
          } else {
              logger.error("[守护] 用户未选择服务器。由于未配置 serverId，守护进程退出。");
              process.exit(1);
          }
      } else {
          logger.error("[守护] 无法获取服务器列表。由于未配置 serverId，守护进程退出。");
          process.exit(1);
      }
  } else if (credentialsEnteredByUser) {
      logger.info(`[守护] 检测到 serverId: ${currentServerId}。因凭据为新输入，将更新到 account.js。`);
      await updateAccountFile(currentServerId, currentUsername, currentPassword, true);
  } else {
      logger.info(`[守护] 用户名、密码及 ServerId 均从 account.js 成功加载。`);
  }
  logger.info("[守护] 账户配置检查完成。");
  // --- 交互逻辑结束 ---

  let childProcess = null;
  const reconnectInterval = 25 * 60 * 1000;
  let isInPauseTime = false;
  let scheduledRestartTime = null;
  let isIntentionalExit = false;
  let fastRestartFlag = false;

  const savedStatus = loadRestartStatus();
  if (savedStatus && savedStatus.needRestart) {
    const elapsedTime = Date.now() - savedStatus.timestamp;
    if (elapsedTime < reconnectInterval) {
      const remainingTime = reconnectInterval - elapsedTime;
      logger.info(`[守护] 检测到上次有未完成的重启任务，将在${Math.ceil(remainingTime / 1000)}秒后重启`);
      await sleep(remainingTime);
    } else {
      logger.info(`[守护] 检测到上次有未完成的重启任务，已超过等待时间，立即尝试重启`);
    }
  }

  function checkIfInPauseTime() {
    const now = new Date();
    const currentHour = parseInt(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }).format(now));
    const currentMinute = parseInt(new Intl.DateTimeFormat('en-US', { minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(now));

    // 上午休眠时段: 3:00 - 8:30
    const inMorningPause = (currentHour >= 3 && currentHour < 8) || (currentHour === 8 && currentMinute < 30);

    // 下午/晚上休眠时段: 15:00 - 22:00
    const inAfternoonPause = (currentHour >= 15 && currentHour < 22);

    if (inMorningPause || inAfternoonPause) {
        return true;
    }
    
    return false;
  }

  function formatTime(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) {
        return '无效日期';
    }
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: 'Asia/Shanghai'
        }).format(date);
    } catch (e) {
        logger.warn("[守护] Intl.DateTimeFormat 格式化时间失败，回退到本地时间格式。", e);
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')} (本地时区)`;
    }
  }

  async function runCmd() {
    if (checkIfInPauseTime()) {
      isInPauseTime = true;
      logger.warn(`[守护] 当前为休眠时间段 (北京时间 3:00-8:30, 15:00-22:00)，暂不启动子进程`);
      return;
    }
    isInPauseTime = false;

    if (childProcess) {
        logger.warn("[守护] runCmd 被调用，但似乎已有子进程存在。");
        return;
    }

    try {
      logger.info("[守护] 正在启动子进程 (./src/index.js)...");
      fastRestartFlag = false; 

      childProcess = spawn("node", ["./src/index.js"], {
        cwd: process.cwd(),
        shell: false,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      
      const streamHandler = (streamData) => {
        const output = streamData.toString();
        if (output.includes("您的操作过于频繁")) {
            logger.warn('[守护] 检测到“操作频繁”错误，将在此次退出后启用快速重启。');
            fastRestartFlag = true;
        }
        process.stdout.write(streamData);
      };
      childProcess.stdout.on('data', streamHandler);
      childProcess.stderr.on('data', streamHandler);

      saveRestartStatus({ needRestart: false, timestamp: Date.now(), pid: childProcess.pid });
      logger.info(`[守护] 子进程已启动，PID: ${childProcess.pid}`);

      childProcess.on("exit", async (code, signal) => {
        const exitedPidForLog = childProcess ? childProcess.pid : '之前PID未知';
        
        if (childProcess) {
            childProcess = null;
        }

        const exitTime = new Date();
        if (isIntentionalExit) {
          logger.info(`[守护] 子进程 (PID: ${exitedPidForLog}) 因计划性操作而退出 (代码: ${code}, 信号: ${signal}).`);
          isIntentionalExit = false;
        } else {
            if (fastRestartFlag) {
                const randomDelay = Math.floor(Math.random() * 121) * 1000;
                logger.info(`[守护] 子进程因“操作频繁”退出，将在 ${Math.round(randomDelay / 1000)} 秒后快速重启。`);
                await sleep(randomDelay);
                await runCmd();
            } else {
                logger.warn(`[守护] 子进程 (PID: ${exitedPidForLog}) 意外退出 (代码: ${code}, 信号: ${signal})，将在25分钟后重启。`);
                scheduledRestartTime = new Date(exitTime.getTime() + reconnectInterval);
                logger.info(`[守护] 预计重启时间: ${formatTime(scheduledRestartTime)} (上海时区)`);
                saveRestartStatus({ needRestart: true, timestamp: Date.now() });
                await restartProcess(code);
            }
        }
      });

      childProcess.on("error", (err) => {
        logger.error(`[守护] 子进程 (PID: ${childProcess ? childProcess.pid : '未知'}) 发生启动错误`, err);
        saveRestartStatus({ needRestart: true, timestamp: Date.now(), error: err.message, errorType: 'spawnError' });
        if (childProcess) {
            childProcess = null;
        }
      });

    } catch (err) {
      logger.error("[守护] 尝试启动子进程失败 (spawn 同步错误)", err);
      childProcess = null;
      logger.info("[守护] 5分钟后将重试启动子进程 (runCmd catch)");
      saveRestartStatus({ needRestart: true, timestamp: Date.now(), errorType: 'spawnSyncError' });
      await sleep(5 * 60 * 1000);
      await runCmd();
    }
  }

  async function restartProcess(exitCode) {
    try {
      const waitStartTime = new Date();
      logger.info(`[守护] 开始等待重启流程 (因之前退出码: ${exitCode})，当前时间: ${formatTime(waitStartTime)} (上海时区)`);

      if (childProcess) {
        logger.warn(`[守护] restartProcess 被调用，但 childProcess 引用仍存在 (PID: ${childProcess.pid})。尝试清理。`);
        try {
          childProcess.kill();
          await sleep(1000);
        } catch (killErr) {
          logger.error("[守护] restartProcess 中尝试清理残余 childProcess 时出错", killErr);
        }
        childProcess = null;
      }

      if (!(scheduledRestartTime instanceof Date) || isNaN(scheduledRestartTime.getTime())) {
          logger.warn("[守护] 计划重启时间无效，将使用当前时间加25分钟");
          scheduledRestartTime = new Date(Date.now() + reconnectInterval);
      }
      logger.info(`[守护] 等待25分钟后重新启动子进程...预计启动时间: ${formatTime(scheduledRestartTime)} (上海时区)`);

      let waitLogIntervalCount = 0;
      const waitLogInterval = setInterval(() => {
        waitLogIntervalCount++;
        const elapsedMinutes = waitLogIntervalCount * 5;
        const remainingMinutes = 25 - elapsedMinutes;
        if (remainingMinutes >= 0) {
            logger.info(`[守护] 重启等待中...已等待${elapsedMinutes}分钟，还剩${remainingMinutes}分钟`);
        } else {
            clearInterval(waitLogInterval);
        }
      }, 5 * 60 * 1000);

      await sleep(reconnectInterval);
      clearInterval(waitLogInterval);

      if (childProcess) {
        logger.info(`[守护] 25分钟等待结束，但检测到子进程 (PID: ${childProcess.pid}) 已由其他任务（如定时重启）启动，故取消本次重启。`);
        saveRestartStatus({ needRestart: false, timestamp: 0 }); 
        return;
      }

      logger.info(`[守护] 25分钟等待结束，当前时间: ${formatTime(new Date())} (上海时区)，准备重新启动子进程`);
      saveRestartStatus({ needRestart: false, timestamp: 0 });
      await runCmd();
    } catch (err)
 {
      logger.error("[守护] 重启子进程过程中发生严重错误", err);
      logger.info("[守护] 5分钟后将重试重启流程 (restartProcess catch)");
      await sleep(5 * 60 * 1000);
      await restartProcess(exitCode);
    }
  }

  async function forceRestart() {
    try {
      logger.info("[守护] 执行计划性重启 (重新启动 ./src/index.js)");
      isIntentionalExit = true;
      if (childProcess) {
        const pidToKill = childProcess.pid;
        logger.info(`[守护] 强制重启：尝试终止当前子进程 (PID: ${pidToKill || '未知'})`);
        childProcess.kill();
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                logger.warn(`[守护] 等待子进程 (PID: ${pidToKill}) 退出超时 (forceRestart's own wait)`);
                resolve();
            }, 10000);
            const tempChild = childProcess;
            if (tempChild) {
                tempChild.once("exit", () => {
                    clearTimeout(timeout);
                    logger.info(`[守护] 强制重启：当前子进程 (PID: ${pidToKill}) 已确认退出`);
                    resolve();
                });
            } else {
                logger.warn(`[守护] forceRestart: childProcess 在设置退出监听前已为 null (PID: ${pidToKill})`);
                clearTimeout(timeout);
                resolve();
            }
        });
        if (childProcess && childProcess.pid === pidToKill) { 
            childProcess = null;
        }
      } else {
        logger.info("[守护] 强制重启：未发现正在运行的子进程。");
      }

      logger.info("[守护] 短暂等待 (5秒) 后启动新进程...");
      await sleep(5000);
      await runCmd();
    } catch (err) {
      logger.error("[守护] 强制重启过程中发生错误", err);
      isIntentionalExit = false;
      logger.info("[守护] 30秒后将重试强制重启");
      await sleep(30 * 1000);
      await forceRestart();
    }
  }

  try {
    const jobOptions = { tz: "Asia/Shanghai" };

    schedule.scheduleJob({ rule: "0 0 0 * * *", ...jobOptions }, async function() {
      const randomDelay = Math.floor(Math.random() * 121) * 1000;
      logger.info(`[守护] 已到达00:00定时重启时间，将在 ${Math.round(randomDelay / 1000)} 秒的随机延迟后执行重启。`);
      await sleep(randomDelay);
      await forceRestart();
    });
    
    schedule.scheduleJob({ rule: "0 0 22 * * *", ...jobOptions }, async function() {
      const randomDelay = Math.floor(Math.random() * 121) * 1000;
      logger.info(`[守护] 已到达22:00定时重启时间，将在 ${Math.round(randomDelay / 1000)} 秒的随机延迟后执行重启。`);
      await sleep(randomDelay);
      await forceRestart();
    });
    
    schedule.scheduleJob({ rule: "0 0 15 * * *", ...jobOptions }, async function() {
      logger.info(`[守护] 进入休眠时间段 (15:00, 时区: ${jobOptions.tz})`);
      isInPauseTime = true;
      if (childProcess) {
        logger.info("[守护] 休眠：正在停止子进程...");
        isIntentionalExit = true;
        childProcess.kill();
      } else {
        logger.info("[守护] 休眠：未发现正在运行的子进程。");
      }
    });

    schedule.scheduleJob({ rule: "0 0 3 * * *", ...jobOptions }, async function() {
      logger.info(`[守护] 进入休眠时间段 (3:00, 时区: ${jobOptions.tz})`);
      isInPauseTime = true;
      if (childProcess) {
        logger.info("[守护] 休眠：正在停止子进程...");
        isIntentionalExit = true;
        childProcess.kill();
      } else {
        logger.info("[守护] 休眠：未发现正在运行的子进程。");
      }
    });

    schedule.scheduleJob({ rule: "0 30 8 * * *", ...jobOptions }, async function() {
      logger.info(`[守护] 结束休眠时间段 (8:30, 时区: ${jobOptions.tz})，准备启动子进程`);
      isInPauseTime = false;
      if (!childProcess) {
          await runCmd();
      } else {
          logger.info(`[守护] 结束休眠：子进程已在运行 (PID: ${childProcess.pid})。不重复启动。`);
      }
    });

    schedule.scheduleJob({ rule: "*/5 * * * *", ...jobOptions }, async function() {
      logger.debug(`[守护] 每5分钟检查执行 (时区: ${jobOptions.tz})`);
      const status = loadRestartStatus();
      if (status && status.needRestart) {
        const elapsedTime = Date.now() - status.timestamp;
        if (elapsedTime >= reconnectInterval) {
          logger.warn("[守护] 每5分钟检查：检测到未完成的重启任务标记，立即执行重启");
          saveRestartStatus({ needRestart: false, timestamp: 0 });
          if (!childProcess) await runCmd(); else logger.warn("[守护] 每5分钟检查：尝试重启，但子进程已存在。");
        }
      }

      if (childProcess && childProcess.pid) {
        try {
          process.kill(childProcess.pid, 0); 
        } catch (err) {
          if (err.code === 'ESRCH') { 
            logger.warn(`[守护] 每5分钟检查：检测到子进程 (PID: ${childProcess.pid}) 已死亡但未正确触发exit事件。标记需要重启。`);
            const deadPid = childProcess.pid;
            childProcess = null;
            if (!isIntentionalExit) {
                saveRestartStatus({ needRestart: true, timestamp: Date.now() - reconnectInterval - 1000, deadPid }); 
                logger.info("[守护] 由于检测到进程死亡，将尝试立即重启（通过下次状态检查或等待的重启流程）。");
            } else {
                logger.info(`[守护] 每5分钟检查：检测到子进程 (PID: ${deadPid}) 死亡，但标记为计划性退出，不自动重启。`);
            }
          } else { 
            logger.error(`[守护] 每5分钟检查：检查子进程存活时发生未知错误 (PID: ${childProcess.pid})`, err);
          }
        }
      } else if (!isInPauseTime && !childProcess && !isIntentionalExit) {
        const currentStatus = loadRestartStatus();
        if(!currentStatus || !currentStatus.needRestart) {
            logger.warn("[守护] 每5分钟检查：检测到子进程不存在且不在休眠期/重启流程/计划退出中，尝试启动。");
            await runCmd();
        }
      }
    });

    schedule.scheduleJob({ rule: "*/1 * * * *", ...jobOptions }, async function() {
      logger.debug(`[守护] 每分钟休眠状态同步检查执行 (时区: ${jobOptions.tz})`);
      const currentlyInPause = checkIfInPauseTime();
      if (currentlyInPause !== isInPauseTime) {
        logger.info(`[守护] 每分钟检查：检测到休眠状态实际变化: 当前应休眠 ${currentlyInPause} (守护进程记录 ${isInPauseTime})`);

        if (currentlyInPause) {
            if (!isInPauseTime && childProcess) {
                 logger.warn("[守护] 每分钟检查：状态不一致！实际应休眠但守护进程认为在运行。强制进入休眠流程。");
                 isInPauseTime = true;
                 isIntentionalExit = true;
                 childProcess.kill();
            } else if (!isInPauseTime && !childProcess) {
                isInPauseTime = true;
                logger.info("[守护] 每分钟检查：状态同步，当前应休眠且无子进程。");
            }
        } else {
            if (isInPauseTime) {
                logger.warn("[守护] 每分钟检查：状态不一致！实际应工作但守护进程认为在休眠。强制进入工作流程。");
                isInPauseTime = false;
                if (!childProcess) {
                    const status = loadRestartStatus();
                    if (!status || !status.needRestart) {
                        await runCmd();
                    }
                }
            }
        }
      }
    });

    logger.info(`[守护] 已成功设置所有定时任务 (统一使用时区: ${jobOptions.tz})`);
  } catch (err) {
    logger.error("[守护] 设置定时任务时发生严重错误", err);
  }

  logger.info("[守护进程] 开始启动...");
  await runCmd();
  logger.info("[守护进程] 初始化启动流程完成 (子进程若在休眠期则不会立即启动)");

})().catch(err => {
  logger.error("[守护] 主函数 (IIFE) 执行出错，守护进程即将退出。", err);
  saveRestartStatus({ needRestart: true, timestamp: Date.now(), errorType: 'mainIIFEError', errorMessage: err.message });
  process.exit(1);
});