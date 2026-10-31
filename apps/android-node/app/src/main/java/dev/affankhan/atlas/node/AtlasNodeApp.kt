package dev.affankhan.atlas.node

import android.app.Application
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner

/**
 * Process-scoped owner for a single authenticated Android Node connection.
 * Both the Activity and the foreground Service obtain the same controller.
 * This prevents duplicate registration/replies during Activity recreation.
 * Nothing from a share is serialized to the ViewModelStore or to disk.
 */
class AtlasNodeApp : Application(), ViewModelStoreOwner {
    override val viewModelStore: ViewModelStore by lazy { ViewModelStore() }

    internal val model: CompanionViewModel by lazy {
        ViewModelProvider(this, ViewModelProvider.AndroidViewModelFactory.getInstance(this))
            .get(CompanionViewModel::class.java)
    }
}
