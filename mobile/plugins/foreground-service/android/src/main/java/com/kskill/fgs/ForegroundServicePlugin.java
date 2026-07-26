package com.kskill.fgs;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ForegroundService")
public class ForegroundServicePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), MacroForegroundService.class);
        intent.putExtra(MacroForegroundService.EXTRA_TITLE, call.getString("title", "KTX 자동 예매"));
        intent.putExtra(MacroForegroundService.EXTRA_BODY, call.getString("body", "빈자리 조회 중…"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        // Re-issuing startForeground with new extras updates the notification.
        start(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), MacroForegroundService.class));
        call.resolve();
    }
}
