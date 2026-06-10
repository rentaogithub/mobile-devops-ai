import { Router, Request, Response } from 'express';
import sentryIssueService from '../services/SentryIssueService';
import qwenAIService from '../services/QwenAIService';
import logger from '../utils/logger';

const router = Router();

router.post('/issues', async (req: Request, res: Response) => {
  try {
    const {
      period = '24h',
      limit = 10,
      query = 'is:unresolved',
    } = req.body || {};

    const issues = await sentryIssueService.listNewIssues({
      period: String(period || '24h'),
      limit: Number(limit || 10),
      query: String(query || 'is:unresolved'),
    });

    res.json({
      success: true,
      data: {
        period,
        query,
        total: issues.length,
        issues,
      },
    });
  } catch (error: any) {
    logger.error('抓取 Sentry 问题列表失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '抓取 Sentry 问题列表失败',
    });
  }
});

router.post('/analyze-selected', async (req: Request, res: Response) => {
  try {
    const {
      apiKey = '',
      issueIds = [],
      issues = [],
    } = req.body || {};

    if (!Array.isArray(issueIds) || issueIds.length === 0) {
      res.status(400).json({
        success: false,
        error: '请选择要分析的 Sentry 问题',
      });
      return;
    }

    const issueMap = new Map((Array.isArray(issues) ? issues : []).map((issue: any) => [String(issue.id), issue]));
    const selectedIssues = issueIds.map((id: string) => issueMap.get(String(id)) || { id: String(id), title: String(id) });

    const results = await Promise.all(selectedIssues.map(async (issue: any) => {
      try {
        const normalizedIssue = sentryIssueService.normalizeIssueSummary(issue);
        const event = await sentryIssueService.getLatestEvent(normalizedIssue.id);
        const analysisLog = sentryIssueService.buildAnalysisLog(normalizedIssue, event);
        const analysis = await qwenAIService.analyzeCrashLog(analysisLog, apiKey);
        return {
          issue: normalizedIssue,
          eventId: event?.id,
          analysisLog,
          analysis,
        };
      } catch (error: any) {
        logger.warn('Sentry 指定 issue AI 分析失败', {
          issueId: issue.id,
          error: error.message,
        });
        return {
          issue,
          error: error.message || 'AI 分析失败',
        };
      }
    }));

    res.json({
      success: true,
      data: {
        total: results.length,
        results,
      },
    });
  } catch (error: any) {
    logger.error('分析指定 Sentry 问题失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '分析指定 Sentry 问题失败',
    });
  }
});

router.post('/fetch-and-analyze', async (req: Request, res: Response) => {
  try {
    const {
      apiKey = '',
      period = '24h',
      limit = 5,
      query = 'is:unresolved',
    } = req.body || {};

    const issues = await sentryIssueService.listNewIssues({
      period: String(period || '24h'),
      limit: Number(limit || 5),
      query: String(query || 'is:unresolved'),
    });

    const results = await Promise.all(issues.map(async (issue) => {
      try {
        const event = await sentryIssueService.getLatestEvent(issue.id);
        const analysisLog = sentryIssueService.buildAnalysisLog(issue, event);
        const analysis = await qwenAIService.analyzeCrashLog(analysisLog, apiKey);
        return {
          issue,
          eventId: event?.id,
          analysisLog,
          analysis,
        };
      } catch (error: any) {
        logger.warn('Sentry issue AI 分析失败', {
          issueId: issue.id,
          error: error.message,
        });
        return {
          issue,
          error: error.message || 'AI 分析失败',
        };
      }
    }));

    res.json({
      success: true,
      data: {
        period,
        query,
        total: results.length,
        results,
      },
    });
  } catch (error: any) {
    logger.error('抓取 Sentry 新增崩溃失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message || '抓取 Sentry 新增崩溃失败',
    });
  }
});

export default router;
