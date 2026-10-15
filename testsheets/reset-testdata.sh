#!/bin/bash
# Reset the nexuserp test container to a clean seeded state (users only, no business data).
# Users (all password Nexus#Test2026): admin(admin,management) sales1(order_management) planner1(planning)
# proc1(procurement) inv1(inventory) fin1(finance) factory1(factory) ship1(shipment) crm1(crm) mgmt1(management)
# Outbound e-mail alerts are disabled (the app ships default SMTP settings).
set -e
cd /home/erp
docker stop nexuserp >/dev/null 2>&1 || true
rm -rf data/db.json data/db.json.* data/db.sandbox.* data/uploads
mkdir -p data/uploads
node -e '
const c=require("crypto");const h=p=>c.createHash("sha256").update(p).digest("hex");
const stub=JSON.parse(require("fs").readFileSync("NexusERP/db.stub.json"));
const P="Nexus#Test2026";
const U=[["admin","Test Admin",["admin","management"]],["sales1","Sales Order Mgr",["order_management"]],["planner1","Planner",["planning"]],["proc1","Procurement",["procurement"]],["inv1","Inventory",["inventory"]],["fin1","Finance",["finance"]],["factory1","Factory",["factory"]],["ship1","Shipment",["shipment"]],["crm1","CRM",["crm"]],["mgmt1","Management",["management"]]];
stub.users=U.map(([u,n,r])=>({id:"u_"+u,username:u,name:n,email:u+"@test.local",roles:r,groupIds:[],password:h(P)}));
stub.settings=[{id:"system_settings",enableNewOrderAlerts:false,emailConfig:{smtpServer:"",smtpPort:25,username:"",password:"",senderName:"Nexus Test",senderEmail:"noreply@test.local",useSsl:false}}];
stub.modules=[{id:"system_modules",orderManagement:true,procurement:true,crm:true,inventory:true,technicalReview:true,suppliers:true,shipping:true,reception:true,finance:true,factory:true,govEInvoice:true}];
require("fs").writeFileSync("data/db.json",JSON.stringify(stub,null,1));'
docker start nexuserp >/dev/null
for i in $(seq 30); do curl -s -o /dev/null localhost:5005/ && break; sleep 1; done
echo "nexuserp reset, http://localhost:5005"
