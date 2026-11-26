import { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  onGoHome: () => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

/**
 * Isolates unexpected view-level React rendering failures so MiniPlayer, audio playback,
 * and navigation chrome keep operating cleanly and users can recover in one click.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: '',
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'Lỗi hiển thị không xác định.',
    };
  }

  componentDidUpdate(prevProps: AppErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, errorMessage: '' });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      void window.losslessApi?.recordDiagnosticLog?.({
        level: 'error',
        scope: 'renderer-ui',
        code: 'REACT_ERROR_BOUNDARY',
        message: error?.message || 'Unexpected React render error',
        detail: `${error?.stack || ''}\n${info?.componentStack || ''}`.slice(0, 1200),
      });
    } catch {
      // Never throw inside error boundary reporting
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  private handleGoHome = (): void => {
    this.setState({ hasError: false, errorMessage: '' });
    this.props.onGoHome();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="mx-auto my-12 max-w-lg rounded-2xl border border-white/10 bg-black/30 p-6 text-center backdrop-blur-md">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Trang hiển thị gặp sự cố tạm thời
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Trình phát nhạc và thư viện của bạn vẫn an toàn. Bạn có thể tải lại trang hiện tại hoặc quay về Trang chủ.
        </p>
        {this.state.errorMessage && (
          <p className="mt-3 rounded-lg bg-black/25 px-3 py-2 text-xs text-rose-300/90">
            {this.state.errorMessage}
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-xs font-medium text-white transition hover:opacity-90"
          >
            Thử tải lại trang
          </button>
          <button
            type="button"
            onClick={this.handleGoHome}
            className="rounded-lg border border-white/15 px-4 py-2 text-xs font-medium text-[var(--text-primary)] transition hover:bg-white/10"
          >
            Về Trang chủ
          </button>
        </div>
      </div>
    );
  }
}
