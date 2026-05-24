/**
 * Pondérations pour le système de scoring
 * Basé sur la fiabilité et la difficulté de spoof de chaque identifiant
 */

module.exports = {
    // === IDENTIFIANTS PRINCIPAUX (HWID) ===
    hwid: {
        // Très difficiles à spoofer correctement
        smbiosUuid: 40,
        diskSerial: 35,
        baseboardSerial: 30,
        
        // Difficiles mais possibles
        tpm: 25,
        secureBoot: 20,
        biosVendor: 15,
        biosVersion: 15,
        biosDate: 10,
        diskModel: 10,
        diskFirmware: 10,
        
        // Identifiants secondaires
        cpuModel: 15,
        cpuFamily: 10,
        cpuStepping: 5,
        gpuVendor: 15,
        gpuDevice: 15,
        gpuSubsystem: 10,
        ramAmount: 5,
        ramSlots: 5,
        
        // Périphériques (faible poids, changent souvent)
        monitor: 10,
        monitorEdid: 8,
        audioDevice: 3,
        usbDevice: 5,
        usbTopology: 8,
        
        // Windows (peuvent changer légitimement)
        machineGuid: 20,
        windowsVersion: 5,
        windowsBuild: 3
    },
    
    // === RÉSEAU ===
    network: {
        ip: 5,              // Très faible, peut changer légitimement
        asn: 10,            // Plus stable que l'IP
        isp: 8,
        datacenter: 15,     // Suspect si datacenter
        vpn: 12,            // Suspect mais pas ban seul
        proxy: 15,
        tor: 20,            // Très suspect
        reputation: 10      // Basé sur IP reputation
    },
    
    // === SOURCES DE COLLECTE ===
    // Bonus si multiple sources concordent
    sources: {
        multipleSourcesBonus: 20,
        wmiOnly: -30,       // Pénalité si WMI seul (facile à spoof)
        deviceIoControlPresent: 15,
        smbiosDirectPresent: 15
    },
    
    // === SEUILS DE DÉCISION ===
    thresholds: {
        // Score de match (similarité avec fingerprint existant)
        match: {
            identical: 95,      // Quasi identique
            veryHigh: 85,       // Très similaire
            high: 70,           // Similaire
            medium: 50,         // Moyennement similaire
            low: 30             // Peu similaire
        },
        
        // Score de spoof (incohérences détectées)
        spoof: {
            critical: 80,       // Spoof quasi certain
            high: 60,           // Très suspect
            medium: 40,         // Suspect
            low: 20             // Légèrement suspect
        },
        
        // Score de confiance (fiabilité globale)
        trust: {
            trusted: 80,        // Machine de confiance
            normal: 50,         // Normal
            suspicious: 30,     // Suspect
            untrusted: 10       // Non fiable
        },
        
        // Score d'évasion (probabilité ban evasion)
        evasion: {
            certain: 90,        // Ban evasion quasi certain
            veryHigh: 75,       // Très probable
            high: 60,           // Probable
            medium: 40,         // Possible
            low: 20             // Peu probable
        },
        
        // Score final (décision)
        final: {
            ban: 85,            // Ban automatique
            review: 70,         // Review manuelle requise
            suspicious: 50,     // Surveillance accrue
            normal: 30          // Normal
        }
    },
    
    // === PÉNALITÉS ===
    penalties: {
        // Incohérences
        mismatchWmiVsDeviceIo: 40,
        mismatchMultipleSources: 35,
        nullOrEmptySerial: 25,
        impossibleValue: 50,
        knownSpooferPattern: 60,
        
        // VM / Hypervisor
        vmDetected: 30,
        hypervisorTraces: 25,
        
        // Réseau
        datacenterIp: 20,
        vpnWithSuspiciousHwid: 30,
        torWithSuspiciousHwid: 40,
        multipleIpChanges: 15,
        
        // Comportement
        rapidAccountCreation: 25,
        multipleAccountsSameHwid: 20,
        bannedHwidPartialMatch: 50
    },
    
    // === BONUS ===
    bonus: {
        // Confiance
        longAccountHistory: 15,
        stableHardware: 10,
        stableNetwork: 10,
        tpmPresent: 10,
        secureBootEnabled: 10,
        
        // Cohérence
        allSourcesMatch: 20,
        noInconsistencies: 15,
        legitimateIsp: 10
    },
    
    // === TOLÉRANCE (éviter faux positifs) ===
    tolerance: {
        // Changements légitimes acceptés
        hardwareUpgrade: {
            gpu: true,
            ram: true,
            monitor: true,
            usbDevices: true,
            audioDevices: true
        },
        
        // Changements suspects
        suspiciousChanges: {
            smbiosUuid: true,
            diskSerial: true,
            baseboardSerial: true,
            machineGuid: true
        },
        
        // Seuils de changement acceptables
        maxChangesPerMonth: {
            minor: 5,       // Périphériques USB, etc.
            major: 2        // GPU, RAM, etc.
        }
    }
};
