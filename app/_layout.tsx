import {DarkTheme, DefaultTheme, ThemeProvider} from '@react-navigation/native';
import {Stack} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import {StatusBar} from 'expo-status-bar';
import {useEffect} from 'react';
import {InteractionManager, Platform} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import 'react-native-reanimated';

import {useColorScheme} from '@/hooks/use-color-scheme';
import {AppErrorBoundary} from "@/components/app-error-boundary";

/** Required on Android: marks splash as user-controlled so we must hide explicitly (see SplashScreenModule.kt). */
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export const unstable_settings = {
    anchor: '(tabs)',
};

export default function RootLayout() {
    const colorScheme = useColorScheme();

    useEffect(() => {
        let cancelled = false;

        const hide = () => {
            if (!cancelled) {
                void SplashScreen.hideAsync().catch(() => undefined);
            }
        };

        const interaction = InteractionManager.runAfterInteractions(() => {
            hide();
            requestAnimationFrame(hide);
        });

        const fallbackMs = Platform.OS === 'android' ? 600 : 250;
        const timeout = setTimeout(hide, fallbackMs);

        return () => {
            cancelled = true;
            interaction.cancel?.();
            clearTimeout(timeout);
        };
    }, []);

    return (
        <AppErrorBoundary>
            <GestureHandlerRootView style={{flex: 1}}>
                <SafeAreaProvider>
                    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
                        <Stack>
                            <Stack.Screen name="(tabs)" options={{headerShown: false}}/>
                        </Stack>
                        <StatusBar style="light"/>
                    </ThemeProvider>
                </SafeAreaProvider>
            </GestureHandlerRootView>
        </AppErrorBoundary>

    );
}
