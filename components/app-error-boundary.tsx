import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'string') return new Error(e);
  try {
    return new Error(JSON.stringify(e));
  } catch {
    return new Error(String(e));
  }
}

/**
 * Catches React render/lifecycle errors in descendants. Logs to Metro / Logcat via console.
 * Does not catch: event handlers, async rejections, native crashes, Android ANRs, UI-thread/Reanimated
 * worklet faults that never surface as JS exceptions, or Skia/native faults — those look like hangs
 * with nothing logged here.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const err = toError(error);
    console.error('[AppErrorBoundary] error name:', err?.name);
    console.error('[AppErrorBoundary] error message:', err?.message);
    console.error('[AppErrorBoundary] error:', err);
    console.error('[AppErrorBoundary] stack:', err?.stack);
    console.error('[AppErrorBoundary] componentStack:', info?.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      const { message, stack } = this.state.error;
      return (
        <View style={styles.screen} testID="app-error-boundary">
          <Text style={styles.title}>Render error (check Metro / Logcat)</Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.message}>{message}</Text>
            {stack ? <Text style={styles.stack}>{stack}</Text> : null}
          </ScrollView>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0f0f12',
    paddingTop: 48,
    paddingHorizontal: 16,
  },
  title: {
    color: '#F97316',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  message: {
    color: '#F8FAFC',
    fontSize: 14,
    marginBottom: 16,
  },
  stack: {
    color: '#94A3B8',
    fontSize: 11,
    fontFamily: 'monospace',
  },
});
