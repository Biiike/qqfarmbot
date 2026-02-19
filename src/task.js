/**
 * 任务系统 - 自动领取任务奖励
 */

const { types } = require('./proto');
const { sendMsgAsync, networkEvents } = require('./network');
const { CONFIG } = require('./config');
const { toLong, toNum, log, logWarn, sleep } = require('./utils');

let lastTaskInfo = null;
let taskClaimTimer = null;
let taskClaimRunning = false;

// ============ 任务 API ============

async function getTaskInfo() {
    const body = types.TaskInfoRequest.encode(types.TaskInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'TaskInfo', body);
    const reply = types.TaskInfoReply.decode(replyBody);
    lastTaskInfo = reply.task_info || null;
    
    if (lastTaskInfo) {
        const dailyCount = (lastTaskInfo.daily_tasks || []).length;
        const growthCount = (lastTaskInfo.growth_tasks || []).length;
        const otherCount = (lastTaskInfo.tasks || []).length;
        log('任务', `获取任务信息成功: 每日${dailyCount} 成长${growthCount} 其他${otherCount}`);
        
        const allTasks = [
            ...(lastTaskInfo.daily_tasks || []),
            ...(lastTaskInfo.growth_tasks || []),
            ...(lastTaskInfo.tasks || []),
        ];
        const firstTask = allTasks[0];
        if (firstTask && firstTask.rewards) {
            log('任务', `奖励数据结构示例: ${JSON.stringify(firstTask.rewards)}`);
        }
    }
    
    return reply;
}

function getLastTaskInfo() {
    return lastTaskInfo;
}

async function claimTaskReward(taskId, doShared = false) {
    const body = types.ClaimTaskRewardRequest.encode(types.ClaimTaskRewardRequest.create({
        id: toLong(taskId),
        do_shared: doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'ClaimTaskReward', body);
    return types.ClaimTaskRewardReply.decode(replyBody);
}

async function batchClaimTaskReward(taskIds, doShared = false) {
    const body = types.BatchClaimTaskRewardRequest.encode(types.BatchClaimTaskRewardRequest.create({
        ids: taskIds.map(id => toLong(id)),
        do_shared: doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.taskpb.TaskService', 'BatchClaimTaskReward', body);
    return types.BatchClaimTaskRewardReply.decode(replyBody);
}

// ============ 任务分析 ============

/**
 * 分析任务列表，找出可领取的任务
 */
function analyzeTaskList(tasks) {
    const claimable = [];
    for (const task of tasks) {
        const id = toNum(task.id);
        if (!Number.isFinite(id) || id <= 0) continue;
        const progress = toNum(task.progress);
        const totalProgress = toNum(task.total_progress);
        const isClaimed = task.is_claimed;
        const shareMultiple = toNum(task.share_multiple);

        if (!isClaimed && progress >= totalProgress) {
            claimable.push({
                id,
                desc: task.desc || `任务#${id}`,
                shareMultiple,
                rewards: task.rewards || [],
            });
        }
    }
    return claimable;
}

/**
 * 计算奖励摘要
 */
function getRewardSummary(items) {
    const summary = [];
    for (const item of items) {
        const id = toNum(item.id);
        const count = toNum(item.count);
        // 常见物品ID: 1001=金币, 1002=点券, 1101=经验值
        if (id === 1001) summary.push(`金币${count}`);
        else if (id === 1002) summary.push(`点券${count}`);
        else if (id === 1101) summary.push(`经验值${count}`);
        else if (id === 1) summary.push(`金币${count}`);
        else if (id === 2) summary.push(`经验${count}`);
        else summary.push(`物品#${id}x${count}`);
    }
    return summary.join('/');
}

// ============ 自动领取 ============

/**
 * 检查并领取所有可领取的任务奖励
 */
async function checkAndClaimTasks() {
    if (!CONFIG.autoTask) return;
    if (taskClaimRunning) return;
    taskClaimRunning = true;
    try {
        const reply = await getTaskInfo();
        if (!reply.task_info) return;

        const taskInfo = reply.task_info;
        const allTasks = [
            ...(taskInfo.growth_tasks || []),
            ...(taskInfo.daily_tasks || []),
            ...(taskInfo.tasks || []),
        ];

        const claimable = analyzeTaskList(allTasks);
        if (claimable.length === 0) return;

        log('任务', `发现 ${claimable.length} 个可领取任务`);

        for (const task of claimable) {
            try {
                // 如果有分享翻倍，使用翻倍领取
                const useShare = task.shareMultiple > 1;
                let claimReply;
                let usedShare = false;
                if (useShare) {
                    try {
                        claimReply = await claimTaskReward(task.id, true);
                        usedShare = true;
                    } catch {
                        claimReply = await claimTaskReward(task.id, false);
                    }
                } else {
                    claimReply = await claimTaskReward(task.id, false);
                }
                const multipleStr = usedShare ? ` (${task.shareMultiple}倍)` : '';
                const items = claimReply.items || [];
                const rewardStr = items.length > 0 ? getRewardSummary(items) : '无';

                log('任务', `领取: ${task.desc}${multipleStr} → ${rewardStr}`);
                await sleep(300);
            } catch (e) {
                logWarn('任务', `领取失败 #${task.id}: ${e.message}`);
            }
        }
    } catch (e) {
        logWarn('任务', `自动领取检查失败: ${e.message}`);
    } finally {
        taskClaimRunning = false;
    }
}

/**
 * 处理任务状态变化推送
 */
function onTaskInfoNotify(taskInfo) {
    lastTaskInfo = taskInfo || null;
    
    if (taskInfo) {
        const dailyCount = (taskInfo.daily_tasks || []).length;
        const growthCount = (taskInfo.growth_tasks || []).length;
        const otherCount = (taskInfo.tasks || []).length;
        log('任务', `收到任务推送: 每日${dailyCount} 成长${growthCount} 其他${otherCount}`);
    }
    
    if (!CONFIG.autoTask) return;
    if (!taskInfo) return;

    const allTasks = [
        ...(taskInfo.growth_tasks || []),
        ...(taskInfo.daily_tasks || []),
        ...(taskInfo.tasks || []),
    ];

    const claimable = analyzeTaskList(allTasks);
    if (claimable.length === 0) return;

    // 有可领取任务，延迟后自动领取
    log('任务', `有 ${claimable.length} 个任务可领取，准备自动领取...`);
    setTimeout(() => claimTasksFromList(claimable), 1000);
}

/**
 * 从任务列表领取奖励
 */
async function claimTasksFromList(claimable) {
    if (!CONFIG.autoTask) return;
    for (const task of claimable) {
        try {
            const useShare = task.shareMultiple > 1;
            let claimReply;
            let usedShare = false;
            if (useShare) {
                try {
                    claimReply = await claimTaskReward(task.id, true);
                    usedShare = true;
                } catch {
                    claimReply = await claimTaskReward(task.id, false);
                }
            } else {
                claimReply = await claimTaskReward(task.id, false);
            }
            const multipleStr = usedShare ? ` (${task.shareMultiple}倍)` : '';
            const items = claimReply.items || [];
            const rewardStr = items.length > 0 ? getRewardSummary(items) : '无';

            log('任务', `领取: ${task.desc}${multipleStr} → ${rewardStr}`);
            await sleep(300);
        } catch (e) {
            logWarn('任务', `领取失败 #${task.id}: ${e.message}`);
        }
    }
}

// ============ 初始化 ============

function initTaskSystem() {
    // 监听任务状态变化推送
    networkEvents.on('taskInfoNotify', onTaskInfoNotify);

    if (taskClaimTimer) clearInterval(taskClaimTimer);
    taskClaimTimer = setInterval(() => {
        if (!CONFIG.autoTask) return;
        void checkAndClaimTasks();
    }, 15000);

    // 启动时获取一次任务信息
    setTimeout(async () => {
        try {
            await getTaskInfo();
        } catch {}
        // 如果开启了自动领取，再检查一次
        if (CONFIG.autoTask) {
            checkAndClaimTasks();
        }
    }, 4000);
}

function cleanupTaskSystem() {
    networkEvents.off('taskInfoNotify', onTaskInfoNotify);
    if (taskClaimTimer) {
        clearInterval(taskClaimTimer);
        taskClaimTimer = null;
    }
    taskClaimRunning = false;
}

module.exports = {
    checkAndClaimTasks,
    initTaskSystem,
    cleanupTaskSystem,
    getLastTaskInfo,
    getTaskInfo,
};
