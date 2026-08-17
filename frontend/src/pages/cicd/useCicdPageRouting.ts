import { useEffect, useRef } from 'react';
import { NavigateFunction } from 'react-router-dom';

import { JenkinsBuild, JenkinsBuildListResult } from '../../services/api';
import { CICDSection, getCicdSectionFromPath } from './CicdPageHeader';

interface UseCicdPageRoutingParams {
  pathname: string;
  search: string;
  navigate: NavigateFunction;
  activeSection: CICDSection;
  setActiveSection: (section: CICDSection) => void;
  canUseQuality: boolean;
  builds?: JenkinsBuildListResult | null;
  branches: string[];
  loadBuilds: () => Promise<JenkinsBuildListResult | null>;
  loadBranches: (options?: { silent?: boolean }) => Promise<string[]>;
  refreshQualitySection: () => Promise<unknown>;
  refreshDevicesSection: () => void;
  clearQualityError: () => void;
  showBuildLog: (build: JenkinsBuild) => Promise<void>;
}

export function useCicdPageRouting({
  pathname,
  search,
  navigate,
  activeSection,
  setActiveSection,
  canUseQuality,
  builds,
  branches,
  loadBuilds,
  loadBranches,
  refreshQualitySection,
  refreshDevicesSection,
  clearQualityError,
  showBuildLog,
}: UseCicdPageRoutingParams) {
  const assistantBuildDetailRef = useRef('');

  useEffect(() => {
    if (getCicdSectionFromPath(pathname) === 'release') {
      loadBuilds();
      loadBranches({ silent: true });
    }
  }, []);

  useEffect(() => {
    if (activeSection !== 'release' || !builds?.builds?.length) return;
    const buildParam = new URLSearchParams(search).get('build') || '';
    const buildNumber = Number(buildParam);
    if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
      assistantBuildDetailRef.current = '';
      return;
    }
    if (assistantBuildDetailRef.current === buildParam) return;
    const build = builds.builds.find((item) => item.number === buildNumber);
    if (!build) return;
    assistantBuildDetailRef.current = buildParam;
    void showBuildLog(build);
  }, [activeSection, builds?.builds, search]);

  useEffect(() => {
    const nextSection = getCicdSectionFromPath(pathname);
    if (nextSection === 'quality' && !canUseQuality) {
      navigate('/cicd', { replace: true });
      return;
    }
    setActiveSection(nextSection);
    if (nextSection === 'quality') {
      refreshQualitySection();
    } else if (nextSection === 'devices') {
      refreshDevicesSection();
    } else {
      if (branches.length === 0) {
        loadBranches({ silent: true });
      }
      clearQualityError();
    }
  }, [pathname, canUseQuality, navigate]);
}
