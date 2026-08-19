#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ChileAutos Weekly Update — Cron Script
# 
# Usage: Install on VPS 1 and VPS 2 with crontab:
#   crontab -e
#   0 3 * * 0 /root/scraping_chileautos/cron_update.sh >> /root/scraping_chileautos/cron.log 2>&1
#
# This runs every Sunday at 3:00 AM UTC
# ═══════════════════════════════════════════════════════════════

set -e

# Detect which VPS this is
VPS_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "unknown")

case "$VPS_IP" in
    146.190.142.100)
        VPS_ID=1
        BRANDS="chevrolet,peugeot,ford,hyundai,nissan,bmw,kia,mercedes-benz,volkswagen,suzuki,toyota,mazda,jeep,mitsubishi,mg,citroen,renault,ssangyong,honda,subaru,chery,audi,volvo,jac,great-wall,maxus,changan,fiat,ram,opel,dodge,yamaha,land-rover,haval,mini,porsche,mahindra,foton,triumph,dongfeng,ktm,jmc,dfsk,skoda,geely,jetour,kawasaki,freightliner,samsung,hino,jaguar,ds,baic,lexus,scania,harley-davidson,brilliance,ducati,kyc,gac-motor,seat,international,royal-enfield,exeed,cupra,chrysler,omoda,mack,byd,benelli,infiniti,daihatsu,lifan,faw,cf-moto,maserati,husqvarna,zxauto,alfa-romeo,dfm,iveco,nissan-marubeni,renault-samsung,karry,range-rover,bajaj,nissan-cidef,vespa,daewoo"
        ;;
    159.223.200.170)
        VPS_ID=2
        BRANDS="man,jaecoo,gac,can-am,voge,tesla,zontes,zongshen,keeway,zna,sinotruck,hummer,gwm,aprilia,loncin,indian,daf,king-long,takasaki,motorrad,shineray,brp-can-am,ferrari,kaiyi,sym,fuso,mv-agusta,yutong,niu,hyosung,kymco,abat,gac-gonow,livan,motomorini,mclaren,cobalt,hafei,haouje,austin,aston-martin,bentley,cadillac,haojue,acura,lincoln,haima,maple,cummins,tata,datsun,gas-gas,motoguzzi,gmc,jinbei,kayo,buick,smart,lynk-co,proton,zotye,tvs,swm,leapmotor,lamborghini,lada,zna-dongfeng,dflm,pontiac,horwin,autorrad,abarth,agrale,emoby,beta,kove,sunra,gilera,guzzi,sachs,hisun,lotus,asia,rover,jawa,lambretta,miku,super-soco"
        ;;
    *)
        echo "$(date) ERROR: Unknown VPS IP $VPS_IP — exiting"
        exit 1
        ;;
esac

echo ""
echo "═══════════════════════════════════════════════════"
echo "$(date) 🔄 WEEKLY UPDATE — VPS $VPS_ID"
echo "═══════════════════════════════════════════════════"

cd /root/scraping_chileautos

# Run the update
npx tsx src/cli.ts update --brands "$BRANDS" --vps-id "$VPS_ID"

echo "$(date) ✅ UPDATE COMPLETE — VPS $VPS_ID"
echo "═══════════════════════════════════════════════════"
